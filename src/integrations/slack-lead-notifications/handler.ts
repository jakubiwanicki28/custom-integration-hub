import { createHmac, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import type { Logger } from 'pino';
import { getPersonName, getDealName, getDealStage, getPersonEmail, getPersonPhone } from '../../lib/attio.js';
import type { SlackBlock } from '../../lib/slack.js';
import type { OrgContext, AttioClient, SlackClient, ChannelMapping } from '../../lib/org-context.js';
import type { AttioWebhookPayload, LeadNotificationData, ProcessLeadResult } from './types.js';

const IDEMPOTENCY_TTL = 60 * 60 * 1000; // 1 hour

export function createHandler(ctx: OrgContext) {
  if (!ctx.clients.slack) throw new Error('slack-lead-notifications requires Slack client');
  const attio = ctx.clients.attio;
  const slack = ctx.clients.slack;
  const log = ctx.log.child({ integration: 'slack-lead-notifications' });
  const webhookSecret = ctx.org.webhookSecret;
  const workspaceSlug = ctx.org.attioWorkspaceSlug;

  // Build list → channel mapping from org config
  const listChannelMap = new Map<string, ChannelMapping>();
  const rawMap = (ctx.integrationConfig.listChannelMap ?? {}) as Record<string, ChannelMapping>;
  for (const [listId, mapping] of Object.entries(rawMap)) {
    listChannelMap.set(listId, mapping);
  }

  // Per-instance idempotency (each org gets its own map)
  const processedEntries = new Map<string, number>();
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, timestamp] of processedEntries) {
      if (now - timestamp > IDEMPOTENCY_TTL) processedEntries.delete(key);
    }
  }, 10 * 60 * 1000);
  cleanupInterval.unref();

  let signatureWarningLogged = false;

  // --- Core pipeline ---

  async function enrichLeadData(dealRecordId: string, listId: string): Promise<LeadNotificationData | null> {
    const mapping = listChannelMap.get(listId);
    if (!mapping) {
      log.warn({ listId }, 'Unknown list ID, skipping');
      return null;
    }

    const deal = await attio.getDealDetails(dealRecordId);
    if (!deal) {
      log.error({ dealRecordId }, 'Failed to fetch deal details');
      return null;
    }

    const dealName = getDealName(deal);
    const stage = getDealStage(deal);

    const associatedPeople = deal.values.associated_people as Array<{ target_record_id: string }> | undefined;
    const firstPersonId = associatedPeople?.[0]?.target_record_id;

    let personName = 'Brak powiązanej osoby';
    let email: string | null = null;
    let phone: string | null = null;

    if (firstPersonId) {
      const person = await attio.getPersonDetails(firstPersonId);
      if (person) {
        personName = getPersonName(person);
        email = getPersonEmail(person);
        phone = getPersonPhone(person);
      }
    }

    return { personName, email, phone, dealName, dealRecordId, listName: mapping.listName, stage };
  }

  function formatSlackBlocks(data: LeadNotificationData): { blocks: SlackBlock[]; fallbackText: string } {
    const detailLines: string[] = [];
    if (data.email) detailLines.push(`*Email:*  ${data.email}`);
    if (data.phone) detailLines.push(`*Telefon:*  ${data.phone}`);

    const attioUrl = `https://app.attio.com/${workspaceSlug}/deals/record/${data.dealRecordId}/overview`;

    const blocks: SlackBlock[] = [
      {
        type: 'header',
        text: { type: 'plain_text', text: `Nowy lead — ${data.listName}`, emoji: true },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*${data.personName}*\n${detailLines.join('\n')}` },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Otwórz w Attio' },
            url: attioUrl,
            style: 'primary',
            action_id: 'open_attio_deal',
          },
        ],
      },
    ];

    return { blocks, fallbackText: `Nowy lead: ${data.personName} — ${data.listName}` };
  }

  async function processListEntry(listId: string, dealRecordId: string, idempotencyKey?: string): Promise<void> {
    const mapping = listChannelMap.get(listId);
    if (!mapping) {
      log.warn({ listId }, 'Unknown list ID in webhook');
      return;
    }

    const key = idempotencyKey || `${listId}:${dealRecordId}`;
    if (processedEntries.has(key)) {
      log.info({ key }, 'Entry already processed, skipping');
      return;
    }
    processedEntries.set(key, Date.now());

    const data = await enrichLeadData(dealRecordId, listId);
    if (!data) return;

    const { blocks, fallbackText } = formatSlackBlocks(data);
    const sent = await slack.postMessage(mapping.channelId, blocks, fallbackText);

    if (sent) {
      log.info({ dealRecordId, listName: mapping.listName, channelName: mapping.channelName, personName: data.personName }, 'Lead notification sent');
    } else {
      log.error({ dealRecordId, listName: mapping.listName, channelName: mapping.channelName }, 'Failed to send lead notification');
    }
  }

  // --- Signature verification ---

  function verifySignature(rawBody: Buffer, signature: string): boolean {
    if (!webhookSecret) {
      if (!signatureWarningLogged) {
        log.warn('Webhook signature verification SKIPPED — no ATTIO_WEBHOOK_SECRET configured. Endpoint is open to any sender.');
        signatureWarningLogged = true;
      }
      return true;
    }

    const hmac = createHmac('sha256', webhookSecret);
    hmac.update(rawBody);
    const expected = hmac.digest('hex');

    if (signature.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  }

  // --- Express handler ---

  async function webhookHandler(req: Request, res: Response): Promise<void> {
    if (webhookSecret) {
      const signature = (req.headers['attio-signature'] || req.headers['x-attio-signature']) as string | undefined;
      const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;

      if (!signature || !rawBody || !verifySignature(rawBody, signature)) {
        log.warn({ hasSignature: !!signature, hasRawBody: !!rawBody }, 'Invalid webhook signature');
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }
    }

    // Attio wraps events in { webhook_id, events: [...] }
    const body = req.body as { webhook_id?: string; events?: AttioWebhookPayload[] };
    res.status(200).json({ status: 'accepted' });

    const events = body.events;
    if (!Array.isArray(events) || events.length === 0) {
      log.warn({ bodyKeys: Object.keys(req.body) }, 'Webhook payload has no events array');
      return;
    }

    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

    for (const event of events) {
      if (event.event_type !== 'list-entry.created') {
        log.info({ eventType: event.event_type }, 'Ignoring non-list-entry.created event');
        continue;
      }

      const listId = event.id?.list_id;
      const dealRecordId = event.parent_record_id;

      if (!listId || !dealRecordId) {
        log.error({ event }, 'Missing list_id or parent_record_id in webhook event');
        continue;
      }

      processListEntry(listId, dealRecordId, idempotencyKey).catch(err => {
        const key = idempotencyKey || `${listId}:${dealRecordId}`;
        processedEntries.delete(key);
        log.error({ err, listId, dealRecordId }, 'Unhandled error in lead processing — will retry on next webhook');
      });
    }
  }

  // --- Manual trigger for dashboard ---

  async function processLeadManual(dealRecordId: string, listId: string): Promise<ProcessLeadResult> {
    try {
      const mapping = listChannelMap.get(listId);
      if (!mapping) return { success: false, error: `Nieznana lista: ${listId}` };

      const data = await enrichLeadData(dealRecordId, listId);
      if (!data) return { success: false, error: 'Nie udało się pobrać danych leada z Attio' };

      const { blocks, fallbackText } = formatSlackBlocks(data);
      const sent = await slack.postMessage(mapping.channelId, blocks, fallbackText);

      if (!sent) return { success: false, error: `Błąd wysyłki na Slacka (${mapping.channelName})` };

      return { success: true, personName: data.personName, dealName: data.dealName, slackChannel: mapping.channelName };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Nieznany błąd';
      log.error({ dealRecordId, listId, err }, 'Manual lead processing failed');
      return { success: false, error: message };
    }
  }

  return {
    webhookHandler,
    processLeadManual,
    enrichLeadData,
    listChannelMap,
  };
}
