import { createHmac, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import type { OrgContext } from '../../lib/org-context.js';
import { fetchWithTimeout, safeJson } from '../../lib/fetch.js';
import { getDealName, getAssociatedDealIds } from '../../lib/attio.js';
import { metrics } from '../../lib/metrics.js';
import type { CalendlyWebhookPayload, CampaignListConfig, BookingSyncResult } from './types.js';

const IDEMPOTENCY_TTL = 60 * 60 * 1000; // 1 hour

export function createHandler(ctx: OrgContext) {
  const attio = ctx.clients.attio;
  const log = ctx.log.child({ integration: 'calendly-booking-sync' });
  const webhookSecret = process.env[`${ctx.org.envPrefix}_CALENDLY_WEBHOOK_SECRET`] || '';
  const calendlyToken = process.env[`${ctx.org.envPrefix}_CALENDLY_API_TOKEN`] || '';
  const calendlyUserUri = ctx.integrationConfig.calendlyUserUri as string | undefined;

  const isProduction = process.env.NODE_ENV === 'production';
  if (!webhookSecret && isProduction) {
    log.warn(`No ${ctx.org.envPrefix}_CALENDLY_WEBHOOK_SECRET configured — /webhook endpoint will reject unsigned requests`);
  }

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

    // SSRF protection: only allow Calendly API URLs
    if (!eventUri.startsWith('https://api.calendly.com/')) {
      log.warn({ eventUri: eventUri.slice(0, 80) }, 'Rejected non-Calendly eventUri (possible SSRF attempt)');
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

  /** Search by email, then fallback to recent events without email filter */
  async function getCalendlyBookingTimeByEmail(email: string): Promise<string | null> {
    if (!calendlyToken || !calendlyUserUri) {
      log.warn('Calendly API token or user URI not configured — cannot fetch booking time');
      return null;
    }

    // Initial wait — booking JUST happened, Calendly API needs time to propagate
    log.info({ email }, 'Waiting 10s for Calendly API propagation before email lookup');
    await new Promise(r => setTimeout(r, 10_000));

    // Strategy 1: search by invitee_email (try lowercase — Calendly may be case-sensitive)
    const emailLower = email.toLowerCase();
    const url = new URL('https://api.calendly.com/scheduled_events');
    url.searchParams.set('user', calendlyUserUri);
    url.searchParams.set('invitee_email', emailLower);
    url.searchParams.set('sort', 'start_time:desc');
    url.searchParams.set('count', '1');

    const delays = [10_000, 15_000];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetchWithTimeout(url.toString(), {
          headers: { Authorization: `Bearer ${calendlyToken}` },
        });

        if (!res.ok) {
          log.error({ status: res.status, email: emailLower }, 'Calendly API error (email search)');
          break; // Don't retry on API errors — try fallback instead
        }

        const data = await safeJson<{ collection: Array<{ start_time: string; uri: string; created_at?: string }> }>(res);
        const event = data.collection?.[0];

        if (event?.start_time) {
          log.info({ email, startTime: event.start_time, attempt: attempt + 1 }, 'Calendly booking time found via email search');
          return event.start_time;
        }

        if (attempt < delays.length) {
          log.info({ email, attempt: attempt + 1, nextDelayMs: delays[attempt] }, 'No Calendly booking found by email — retrying');
          await new Promise(r => setTimeout(r, delays[attempt]));
        }
      } catch (err) {
        log.error({ err, email }, 'Failed to query Calendly API (email search)');
        break;
      }
    }

    // Strategy 2: fetch recent events WITHOUT email filter — grab most recent created in last 5 min
    log.info({ email }, 'Email search failed — trying fallback: fetch recent events without email filter');
    try {
      const fallbackUrl = new URL('https://api.calendly.com/scheduled_events');
      fallbackUrl.searchParams.set('user', calendlyUserUri);
      fallbackUrl.searchParams.set('min_start_time', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
      fallbackUrl.searchParams.set('sort', 'start_time:desc');
      fallbackUrl.searchParams.set('count', '5');

      const res = await fetchWithTimeout(fallbackUrl.toString(), {
        headers: { Authorization: `Bearer ${calendlyToken}` },
      });

      if (!res.ok) {
        log.error({ status: res.status }, 'Calendly API error (fallback recent events)');
        return null;
      }

      const data = await safeJson<{ collection: Array<{ start_time: string; uri: string; created_at: string }> }>(res);
      const events = data.collection ?? [];

      log.info({ email, eventsFound: events.length }, 'Fallback: recent Calendly events');

      // Find event created in the last 5 minutes (our booking)
      const fiveMinAgo = Date.now() - 5 * 60 * 1000;
      const recentEvent = events.find(e => new Date(e.created_at).getTime() > fiveMinAgo);

      if (recentEvent?.start_time) {
        log.info({ email, startTime: recentEvent.start_time, eventUri: recentEvent.uri }, 'Calendly booking time found via recent events fallback');
        return recentEvent.start_time;
      }

      log.warn({ email, eventsFound: events.length }, 'No recently created Calendly event found in fallback');
      return null;
    } catch (err) {
      log.error({ err, email }, 'Failed to query Calendly API (fallback)');
      return null;
    }
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
    const trackStart = Date.now();

    // 1. Find Person in Attio by email
    const person = await attio.findPersonByEmail(email);
    if (!person) {
      log.info({ email }, 'Person not found in Attio — not our lead, ignoring');
      metrics.track({ integration: 'calendly-booking-sync', org: ctx.org.id, event: 'skip', durationMs: Date.now() - trackStart, meta: { reason: 'person_not_found' } });
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
      metrics.track({ integration: 'calendly-booking-sync', org: ctx.org.id, event: 'error', durationMs: Date.now() - trackStart, meta: { reason: 'no_start_time' } });
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

    metrics.track({ integration: 'calendly-booking-sync', org: ctx.org.id, event: 'success', durationMs: Date.now() - trackStart, meta: { synced: String(synced) } });
    return { success: true, email };
  }

  // --- Webhook handler ---

  async function webhookHandler(req: Request, res: Response): Promise<void> {
    // Signature verification — reject in production if no secret configured
    if (!webhookSecret && isProduction) {
      res.status(503).json({ error: 'Webhook signature verification not configured' });
      return;
    }

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
      metrics.track({ integration: 'calendly-booking-sync', org: ctx.org.id, event: 'dedup' });
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
      metrics.track({ integration: 'calendly-booking-sync', org: ctx.org.id, event: 'dedup' });
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
