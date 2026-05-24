import { createHmac, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import type { OrgContext } from '../../lib/org-context.js';
import { getDealName, getAssociatedDealIds } from '../../lib/attio.js';
import type { CalendlyWebhookPayload, CampaignListConfig, BookingSyncResult } from './types.js';

const IDEMPOTENCY_TTL = 60 * 60 * 1000; // 1 hour

export function createHandler(ctx: OrgContext) {
  const attio = ctx.clients.attio;
  const log = ctx.log.child({ integration: 'calendly-booking-sync' });
  const webhookSecret = process.env[`${ctx.org.envPrefix}_CALENDLY_WEBHOOK_SECRET`] || '';

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

  // --- Core pipeline ---

  async function syncBooking(email: string, startTime: string): Promise<BookingSyncResult> {
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

    // 3. For each campaign list, find matching entries and update
    for (const [listId, config] of Object.entries(campaignLists)) {
      for (const dealId of dealIds) {
        const entries = await attio.findListEntriesByDeal(listId, dealId);
        if (entries.length === 0) continue;

        const deal = await attio.getDealDetails(dealId);
        const dealName = deal ? getDealName(deal) : dealId;

        for (const entry of entries) {
          // Update deal with consultation date
          await attio.updateDealValues(dealId, {
            data_konsultacji: startTime,
          });

          // Update list entry status to "Konsultacja umówiona"
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

    // Idempotency
    const key = `${email}:${startTime}`;
    if (processedEvents.has(key)) {
      log.info({ key }, 'Booking already processed, skipping');
      return;
    }
    processedEvents.set(key, Date.now());

    syncBooking(email, startTime || '').catch(err => {
      processedEvents.delete(key);
      log.error({ err, email }, 'Unhandled error in booking sync');
    });
  }

  // --- Manual trigger for dashboard ---

  async function processManual(email: string): Promise<BookingSyncResult> {
    try {
      return await syncBooking(email, new Date().toISOString());
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      log.error({ err, email }, 'Manual booking sync failed');
      return { success: false, email, error: msg };
    }
  }

  return { webhookHandler, processManual, campaignLists };
}
