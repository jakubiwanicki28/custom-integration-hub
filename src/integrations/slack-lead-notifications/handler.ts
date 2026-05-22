import { createHmac, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import { createLogger } from '../../lib/logger.js';
import * as attio from '../../lib/attio.js';
import * as slack from '../../lib/slack.js';
import { config } from '../../config.js';
import type { SlackBlock } from '../../lib/slack.js';
import type { AttioWebhookPayload, LeadNotificationData, ProcessLeadResult } from './types.js';

const log = createLogger('slack-lead-notifications');

// --- List → Channel mapping ---

interface ChannelMapping {
  listName: string;
  channelId: string;
  channelName: string;
}

export const LIST_CHANNEL_MAP = new Map<string, ChannelMapping>([
  ['a87fbbdf-8cab-4630-a3cc-9f5756dc944a', {
    listName: 'Akademia Biznesu',
    channelId: 'C0B4Z6TMFGC',
    channelName: '#nowe-leady-akademia',
  }],
  ['2e7cb019-4c0e-45c9-8998-c58590a733ef', {
    listName: 'Raport Strategiczny',
    channelId: 'C0B4TG9S4K0',
    channelName: '#nowe-leady-raport',
  }],
]);

// --- Idempotency ---

const processedEntries = new Map<string, number>();
const IDEMPOTENCY_TTL = 60 * 60 * 1000; // 1 hour

function cleanupProcessed() {
  const now = Date.now();
  for (const [key, timestamp] of processedEntries) {
    if (now - timestamp > IDEMPOTENCY_TTL) {
      processedEntries.delete(key);
    }
  }
}

const cleanupInterval = setInterval(cleanupProcessed, 10 * 60 * 1000);
cleanupInterval.unref();

// --- Core pipeline ---

async function enrichLeadData(dealRecordId: string, listId: string): Promise<LeadNotificationData | null> {
  const mapping = LIST_CHANNEL_MAP.get(listId);
  if (!mapping) {
    log.warn({ listId }, 'Unknown list ID, skipping');
    return null;
  }

  // Fetch deal details
  const deal = await attio.getDealDetails(dealRecordId);
  if (!deal) {
    log.error({ dealRecordId }, 'Failed to fetch deal details');
    return null;
  }

  const dealName = attio.getDealName(deal);
  const stage = attio.getDealStage(deal);

  // Resolve associated person (deal → person)
  const associatedPeople = deal.values.associated_people as Array<{ target_record_id: string }> | undefined;
  const firstPersonId = associatedPeople?.[0]?.target_record_id;

  let personName = 'Brak powiązanej osoby';
  let email: string | null = null;
  let phone: string | null = null;

  if (firstPersonId) {
    const person = await attio.getPersonDetails(firstPersonId);
    if (person) {
      personName = attio.getPersonName(person);
      email = attio.getPersonEmail(person);
      phone = attio.getPersonPhone(person);
    }
  }

  return {
    personName,
    email,
    phone,
    dealName,
    dealRecordId,
    listName: mapping.listName,
    stage,
  };
}

function formatSlackBlocks(data: LeadNotificationData): { blocks: SlackBlock[]; fallbackText: string } {
  const detailLines: string[] = [];
  if (data.email) detailLines.push(`*Email:*  ${data.email}`);
  if (data.phone) detailLines.push(`*Telefon:*  ${data.phone}`);

  const attioUrl = `https://app.attio.com/objects/${DEALS_OBJECT_ID}/records/${data.dealRecordId}`;

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

  const fallbackText = `Nowy lead: ${data.personName} — ${data.listName}`;

  return { blocks, fallbackText };
}

const DEALS_OBJECT_ID = '1ec7de82-968c-4a65-9f3e-8c3c9bdbb84b';

async function processListEntry(listId: string, dealRecordId: string, idempotencyKey?: string): Promise<void> {
  const mapping = LIST_CHANNEL_MAP.get(listId);
  if (!mapping) {
    log.warn({ listId }, 'Unknown list ID in webhook');
    return;
  }

  // Idempotency check
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

// --- Manual trigger for dashboard ---

export async function processLeadManual(dealRecordId: string, listId: string): Promise<ProcessLeadResult> {
  try {
    const mapping = LIST_CHANNEL_MAP.get(listId);
    if (!mapping) {
      return { success: false, error: `Nieznana lista: ${listId}` };
    }

    const data = await enrichLeadData(dealRecordId, listId);
    if (!data) {
      return { success: false, error: 'Nie udało się pobrać danych leada z Attio' };
    }

    const { blocks, fallbackText } = formatSlackBlocks(data);
    const sent = await slack.postMessage(mapping.channelId, blocks, fallbackText);

    if (!sent) {
      return { success: false, error: `Błąd wysyłki na Slacka (${mapping.channelName})` };
    }

    return {
      success: true,
      personName: data.personName,
      dealName: data.dealName,
      slackChannel: mapping.channelName,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Nieznany błąd';
    log.error({ dealRecordId, listId, err }, 'Manual lead processing failed');
    return { success: false, error: message };
  }
}

// --- Webhook signature verification ---

function verifySignature(rawBody: Buffer, signature: string): boolean {
  const secret = config.attio.webhookSecret;
  if (!secret) return true; // Skip if no secret configured

  const hmac = createHmac('sha256', secret);
  hmac.update(rawBody);
  const expected = hmac.digest('hex');

  if (signature.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// --- Express handler ---

export async function webhookHandler(req: Request, res: Response): Promise<void> {
  // Verify signature if secret is configured
  if (config.attio.webhookSecret) {
    const signature = (req.headers['attio-signature'] || req.headers['x-attio-signature']) as string | undefined;
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;

    if (!signature || !rawBody || !verifySignature(rawBody, signature)) {
      log.warn({ hasSignature: !!signature, hasRawBody: !!rawBody }, 'Invalid webhook signature');
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }
  }

  const payload = req.body as AttioWebhookPayload;

  // Respond immediately — Attio has 5s timeout
  res.status(200).json({ status: 'accepted' });

  if (payload.event_type !== 'list-entry.created') {
    log.info({ eventType: payload.event_type }, 'Ignoring non-list-entry.created event');
    return;
  }

  const listId = payload.id?.list_id;
  const dealRecordId = payload.parent_record_id;
  const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

  if (!listId || !dealRecordId) {
    log.error({ payload }, 'Missing list_id or parent_record_id in webhook payload');
    return;
  }

  processListEntry(listId, dealRecordId, idempotencyKey).catch(err => {
    log.error({ err, listId, dealRecordId }, 'Unhandled error in lead processing');
  });
}
