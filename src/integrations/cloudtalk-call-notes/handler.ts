import type { Request, Response } from 'express';
import { getPersonName, getDealName } from '../../lib/attio.js';
import type { OrgContext } from '../../lib/org-context.js';
import { metrics } from '../../lib/metrics.js';
import type { CloudTalkCall } from '../../lib/cloudtalk.js';
import { formatNote } from './summarize.js';
import type { CloudTalkWebhookPayload } from './types.js';

export interface ProcessResult {
  success: boolean;
  personName?: string;
  dealName?: string;
  notesCreated?: number;
  error?: string;
}

const IDEMPOTENCY_TTL = 60 * 60 * 1000; // 1 hour
const MIN_CALL_DURATION = 30; // seconds

export function createHandler(ctx: OrgContext, transcribeCall: (call: CloudTalkCall) => Promise<{ transcript: string; summary: string } | null>) {
  if (!ctx.clients.cloudtalk) throw new Error('cloudtalk-call-notes handler requires CloudTalk client');
  const attio = ctx.clients.attio;
  const cloudtalk = ctx.clients.cloudtalk;
  const log = ctx.log.child({ integration: 'cloudtalk-call-notes' });

  // Per-instance idempotency
  const processedCalls = new Map<string, number>();
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, timestamp] of processedCalls) {
      if (now - timestamp > IDEMPOTENCY_TTL) processedCalls.delete(id);
    }
  }, 10 * 60 * 1000);
  cleanupInterval.unref();

  function isCallProcessed(callId: string): boolean {
    return processedCalls.has(callId);
  }

  function markCallProcessed(callId: string): void {
    processedCalls.set(callId, Date.now());
  }

  // --- Core processing logic (single code path for all entry points) ---

  async function processCallCore(call: CloudTalkCall): Promise<ProcessResult> {
    const callId = call.id;
    const trackStart = Date.now();

    if (call.duration < MIN_CALL_DURATION) {
      metrics.track({ integration: 'cloudtalk-call-notes', org: ctx.org.id, event: 'skip', durationMs: Date.now() - trackStart, meta: { reason: 'short_call' } });
      return { success: false, error: `Rozmowa za krótka (${call.duration}s < ${MIN_CALL_DURATION}s)` };
    }

    const phoneNumber = call.externalNumber;
    if (!phoneNumber) {
      metrics.track({ integration: 'cloudtalk-call-notes', org: ctx.org.id, event: 'skip', durationMs: Date.now() - trackStart, meta: { reason: 'no_phone' } });
      return { success: false, error: 'Brak numeru telefonu' };
    }

    let person = await attio.findPersonByPhone(phoneNumber);

    if (!person && call.contactEmails.length > 0) {
      for (const email of call.contactEmails) {
        person = await attio.findPersonByEmail(email);
        if (person) break;
      }
    }

    if (!person) {
      metrics.track({ integration: 'cloudtalk-call-notes', org: ctx.org.id, event: 'skip', durationMs: Date.now() - trackStart, meta: { reason: 'person_not_found' } });
      return { success: false, error: `Osoba ${phoneNumber} nie znaleziona w Attio` };
    }

    const personName = getPersonName(person);
    const deal = await attio.pickBestDeal(person);
    const dealName = deal ? getDealName(deal) : null;

    log.info({ callId, personName, dealName, dealRecordId: deal?.id.record_id ?? null }, 'Context resolved');

    const aiResult = await transcribeCall(call);
    const { personNote, dealNote } = formatNote({
      call, dealName,
      summary: aiResult?.summary ?? null,
      transcript: aiResult?.transcript ?? null,
    });

    let notesCreated = 0;

    const personNoteId = await attio.createNote({
      parentObject: 'people',
      parentRecordId: person.id.record_id,
      title: personNote.title,
      content: personNote.content,
    });
    if (personNoteId) {
      log.info({ callId, personName, noteId: personNoteId }, 'Person note created');
      notesCreated++;
    }

    if (dealNote && deal) {
      const dealNoteId = await attio.createNote({
        parentObject: 'deals',
        parentRecordId: deal.id.record_id,
        title: dealNote.title,
        content: dealNote.content,
      });
      if (dealNoteId) {
        log.info({ callId, dealName, noteId: dealNoteId }, 'Deal note created');
        notesCreated++;
      }
    }

    metrics.track({ integration: 'cloudtalk-call-notes', org: ctx.org.id, event: 'success', durationMs: Date.now() - trackStart, meta: { notesCreated: String(notesCreated) } });
    return { success: true, personName, dealName: dealName ?? undefined, notesCreated };
  }

  // --- Entry point: poller (has CloudTalkCall) / dashboard (has callId only) ---

  async function processCallManual(callId: string, existingCall?: CloudTalkCall): Promise<ProcessResult> {
    try {
      log.info({ callId, source: existingCall ? 'poller' : 'manual' }, 'Processing started');

      const call = existingCall ?? await cloudtalk.getCallDetails(callId);
      if (!call) return { success: false, error: `Nie znaleziono rozmowy ${callId} w CloudTalk` };

      return await processCallCore(call);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Nieznany błąd';
      log.error({ callId, err }, 'Processing failed');
      return { success: false, error: message };
    }
  }

  // --- Entry point: webhook ---

  async function webhookHandler(req: Request, res: Response): Promise<void> {
    const payload = req.body as CloudTalkWebhookPayload;
    const callId = payload?.call_id ?? payload?.call_uuid;

    if (!callId) {
      res.status(400).json({ error: 'Missing call_id or call_uuid' });
      return;
    }

    if (processedCalls.has(callId)) {
      log.info({ callId }, 'Call already processed, skipping webhook');
      metrics.track({ integration: 'cloudtalk-call-notes', org: ctx.org.id, event: 'dedup' });
      res.status(200).json({ status: 'already_processed' });
      return;
    }

    res.status(200).json({ status: 'accepted' });

    // Mark processed BEFORE starting — prevents poller/webhook race condition (duplicate notes).
    // If processing fails, key expires via 1h TTL. Manual retry available via dashboard.
    markCallProcessed(callId);

    try {
      log.info({ callId }, 'Processing call from webhook');

      const call = await cloudtalk.getCallDetails(callId);
      if (!call) {
        log.error({ callId }, 'Could not fetch call details');
        return;
      }

      const result = await processCallCore(call);

      if (result.success) {
        log.info({ callId, personName: result.personName, dealName: result.dealName, notesCreated: result.notesCreated }, 'Webhook processing complete');
      } else {
        log.warn({ callId, error: result.error }, 'Webhook processing failed — idempotency key kept, will expire via TTL');
      }
    } catch (err) {
      metrics.track({ integration: 'cloudtalk-call-notes', org: ctx.org.id, event: 'error', meta: { reason: 'webhook_error' } });
      log.error({ err, callId }, 'Unhandled error in webhook processing — idempotency key kept, will expire via TTL');
    }
  }

  return {
    webhookHandler,
    processCallManual,
    isCallProcessed,
    markCallProcessed,
  };
}
