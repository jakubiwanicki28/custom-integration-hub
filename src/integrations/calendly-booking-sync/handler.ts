import { createHmac, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import type { OrgContext } from '../../lib/org-context.js';
import { fetchWithTimeout, safeJson } from '../../lib/fetch.js';
import { getDealName, getAssociatedDealIds } from '../../lib/attio.js';
import type { CalendlyWebhookPayload, CampaignListConfig, BookingSyncResult } from './types.js';

const IDEMPOTENCY_TTL = 60 * 60 * 1000; // 1 hour

export function createHandler(ctx: OrgContext) {
  const attio = ctx.clients.attio;
  const log = ctx.log.child({ integration: 'calendly-booking-sync' });
  const webhookSecret = process.env[`${ctx.org.envPrefix}_CALENDLY_WEBHOOK_SECRET`] || '';
  const calendlyToken = process.env[`${ctx.org.envPrefix}_CALENDLY_API_TOKEN`] || '';
  const calendlyUserUri = ctx.integrationConfig.calendlyUserUri as string | undefined;

  const campaignLists = (ctx.integrationConfig.campaignLists ?? {}) as Record<string, CampaignListConfig>;

  // Idempotency
  const processedEvents = new Map<string, number>();
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, ts] of processedEvents) {
      if (now - ts > IDEMPOTENCY_TTL) processedEvents.delete(key);
    }
  }, 10 * 60_000);
  cleanupInterval.unref();

  // --- Signature verification ---

  function verifySignature(rawBody: Buffer, signatureHeader: string): boolean {
    if (!webhookSecret) {
      log.warn('Calendly webhook signature verification SKIPPED — no secret configured');
      return true;
    }

    // Format: "timestamp,signature"
    const [timestamp, signature] = signatureHeader.split(',');
    if (!timestamp || !signature) return false;

    const payloadToSign = `${timestamp}.${rawBody.toString('utf-8')}`;
    const expected = createHmac('sha256', webhookSecret).update(payloadToSign).digest('hex');

    if (signature.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  }

  // --- Calendly API lookup ---

  /** Direct lookup by event URI — most reliable, no search needed */
  async function getCalendlyBookingTimeByEvent(eventUri: string): Promise<string | null> {
    if (!calendlyToken) {
      log.warn('Calendly API token not configured — cannot fetch booking time');
      return null;
    }

    try {
      const res = await fetchWithTimeout(eventUri, {
        headers: { Authorization: `Bearer ${calendlyToken}` },
      });

      if (!res.ok) {
        log.error({ status: res.status, eventUri }, 'Calendly event lookup failed');
        return null;
      }

      const data = await safeJson<{ resource: { start_time: string } }>(res);
      const startTime = data.resource?.start_time;

      if (startTime) {
        log.info({ eventUri, startTime }, 'Calendly booking time found via event URI');
        return startTime;
      }

      log.warn({ eventUri }, 'Calendly event found but missing start_time');
      return null;
    } catch (err) {
      log.error({ err, eventUri }, 'Failed to fetch Calendly event');
      return null;
    }
  }

  /** Search by email — fallback when no event URI available */
  async function getCalendlyBookingTimeByEmail(email: string): Promise<string | null> {
    if (!calendlyToken || !calendlyUserUri) {
      log.warn('Calendly API token or user URI not configured — cannot fetch booking time');
      return null;
    }

    const url = new URL('https://api.calendly.com/scheduled_events');
    url.searchParams.set('user', calendlyUserUri);
    url.searchParams.set('invitee_email', email);
    url.searchParams.set('sort', 'start_time:desc');
    url.searchParams.set('count', '1');

    // Retry up to 3 times with increasing delay — Calendly API can be slow to propagate
    const delays = [5000, 8000]; // delays before 2nd and 3rd attempts
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetchWithTimeout(url.toString(), {
          headers: { Authorization: `Bearer ${calendlyToken}` },
        });

        if (!res.ok) {
          log.error({ status: res.status, email }, 'Calendly API error');
          return null;
        }

        const data = await safeJson<{ collection: Array<{ start_time: string }> }>(res);
        const startTime = data.collection?.[0]?.start_time;

        if (startTime) {
          log.info({ email, startTime }, 'Calendly booking time found via email search');
          return startTime;
        }

        if (attempt < delays.length) {
          const delay = delays[attempt];
          log.info({ email, attempt: attempt + 1, nextDelayMs: delay }, 'No Calendly booking found yet — retrying');
          await new Promise(r => setTimeout(r, delay));
        }
      } catch (err) {
        log.error({ err, email }, 'Failed to query Calendly API');
        return null;
      }
    }

    log.warn({ email }, 'No Calendly booking found after 3 retries');
    return null;
  }

  /** Try event URI first (instant, reliable), fall back to email search */
  async function getCalendlyBookingTime(email: string, eventUri?: string): Promise<string | null> {
    if (eventUri) {
      const startTime = await getCalendlyBookingTimeByEvent(eventUri);
      if (startTime) return startTime;
      log.info({ email, eventUri }, 'Event URI lookup failed — falling back to email search');
    }
    return getCalendlyBookingTimeByEmail(email);
  }

  // --- Core pipeline ---

  async function syncBooking(email: string, startTime: string | null): Promise<BookingSyncResult> {
    // 1. Find Person in Attio by email
    const person = await attio.findPersonByEmail(email);
    if (!person) {
      log.info({ email }, 'Person not found in Attio — not our lead, ignoring');
      return { success: true, email }; // Not an error — just not our lead
    }

    // 2. Find associated deals
    const dealIds = getAssociatedDealIds(person);
    if (dealIds.length === 0) {
      log.warn({ email }, 'Person found but has no deals');
      return { success: false, email, error: 'No deals associated with person' };
    }

    let synced = 0;

    // 3. Update deals and campaign list entries — only if we have a confirmed booking time
    if (!startTime) {
      log.warn({ email }, 'No booking time available — skipping status update to avoid false positives');
      return { success: false, email, error: 'Calendly booking time not found' };
    }

    const updatedDeals = new Set<string>();

    for (const [listId, config] of Object.entries(campaignLists)) {
      for (const dealId of dealIds) {
        const entries = await attio.findListEntriesByDeal(listId, dealId);
        if (entries.length === 0) continue;

        // Update deal once (not per entry)
        if (!updatedDeals.has(dealId)) {
          await attio.updateDealValues(dealId, { data_konsultacji: startTime });
          updatedDeals.add(dealId);
        }

        const deal = await attio.getDealDetails(dealId);
        const dealName = deal ? getDealName(deal) : dealId;

        for (const entry of entries) {
          await attio.updateListEntry(listId, entry.id.entry_id, {
            [config.statusSlug]: [{ status: config.konsultacjaStageId }],
            data_konsultacji: startTime,
          });

          log.info({ email, dealName, listName: config.listName, entryId: entry.id.entry_id }, 'Booking synced — status updated to Konsultacja umówiona');
          synced++;
        }
      }
    }

    if (synced === 0) {
      log.info({ email }, 'Person found but no matching campaign list entries');
      return { success: true, email }; // Not an error — person exists but not in our campaigns
    }

    return { success: true, email };
  }

  // --- Webhook handler ---

  async function webhookHandler(req: Request, res: Response): Promise<void> {
    // Signature verification
    if (webhookSecret) {
      const signatureHeader = req.headers['calendly-webhook-signature'] as string | undefined;
      const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;

      if (!signatureHeader || !rawBody || !verifySignature(rawBody, signatureHeader)) {
        log.warn({ hasSignature: !!signatureHeader }, 'Invalid Calendly webhook signature');
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }
    }

    const body = req.body as CalendlyWebhookPayload;
    res.status(200).json({ status: 'accepted' });

    if (body.event !== 'invitee.created') {
      log.info({ event: body.event }, 'Ignoring non-invitee.created event');
      return;
    }

    const email = body.payload?.email;
    const startTime = body.payload?.calendar_event?.start_time;

    if (!email) {
      log.error('Missing email in Calendly webhook payload');
      return;
    }

    if (!startTime) {
      log.warn({ email }, 'Missing start_time in Calendly webhook — skipping');
      return;
    }

    // Idempotency
    const key = `${email}:${startTime}`;
    if (processedEvents.has(key)) {
      log.info({ key }, 'Booking already processed, skipping');
      return;
    }
    processedEvents.set(key, Date.now());

    syncBooking(email, startTime).catch(err => {
      processedEvents.delete(key);
      log.error({ err, email }, 'Unhandled error in booking sync');
    });
  }

  // --- Manual trigger for dashboard ---

  async function processManual(email: string): Promise<BookingSyncResult> {
    try {
      const startTime = await getCalendlyBookingTime(email);
      return await syncBooking(email, startTime);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      log.error({ err, email }, 'Manual booking sync failed');
      return { success: false, email, error: msg };
    }
  }

  // --- LP frontend notification (replaces Calendly webhook for free plan) ---

  async function notifyHandler(req: Request, res: Response): Promise<void> {
    const { email, eventUri } = req.body as { email?: string; eventUri?: string };
    if (!email) {
      res.status(400).json({ ok: false, error: 'Missing email' });
      return;
    }

    res.status(200).json({ ok: true });

    const key = `notify:${email}`;
    if (processedEvents.has(key)) {
      log.info({ key }, 'Booking notification already processed, skipping');
      return;
    }
    processedEvents.set(key, Date.now());

    getCalendlyBookingTime(email, eventUri).then(startTime => {
      return syncBooking(email, startTime);
    }).then(result => {
      // Clear idempotency key if booking time wasn't found — allow retry later
      if (result && !result.success && result.error === 'Calendly booking time not found') {
        processedEvents.delete(key);
      }
    }).catch(err => {
      processedEvents.delete(key);
      log.error({ err, email }, 'Unhandled error in booking notify sync');
    });
  }

  return { webhookHandler, notifyHandler, processManual, campaignLists };
}
