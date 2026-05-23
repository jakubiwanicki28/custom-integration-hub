import type { Request, Response } from 'express';
import type { Logger } from 'pino';
import { getPersonName, getDealName } from '../../lib/attio.js';
import type { OrgContext, AttioClient, CloudTalkClient } from '../../lib/org-context.js';
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

export function createHandler(ctx: OrgContext, transcribeCall: (call: import('../../lib/cloudtalk.js').CloudTalkCall) => Promise<{ transcript: string; summary: string } | null>) {
  const attio = ctx.clients.attio;
  const cloudtalk = ctx.clients.cloudtalk!;
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

  async function processCall(payload: CloudTalkWebhookPayload): Promise<void> {
    const callId = payload.call_id ?? payload.call_uuid;
    if (!callId) {
      log.error({ payload }, 'No call_id in webhook payload');
      return;
    }

    if (processedCalls.has(callId)) {
      log.info({ callId }, 'Call already processed, skipping');
      return;
    }
    processedCalls.set(callId, Date.now());

    log.info({ callId }, 'Processing call');

    const call = await cloudtalk.getCallDetails(callId);
    if (!call) {
      log.error({ callId }, 'Could not fetch call details');
      return;
    }

    if (call.duration < MIN_CALL_DURATION) {
      log.info({ callId, duration: call.duration }, 'Call too short, skipping');
      return;
    }

    const phoneNumber = call.externalNumber || payload.phone_number;
    if (!phoneNumber) {
      log.error({ callId }, 'No phone number available');
      return;
    }

    let person = await attio.findPersonByPhone(phoneNumber);

    if (!person && call.contactEmails.length > 0) {
      for (const email of call.contactEmails) {
        person = await attio.findPersonByEmail(email);
        if (person) break;
      }
    }

    if (!person) {
      log.warn({ callId, phoneNumber, contactEmails: call.contactEmails }, 'Person not found in Attio, skipping');
      return;
    }

    const personRecordId = person.id.record_id;
    const personName = getPersonName(person);

    const deal = await attio.pickBestDeal(person);
    const dealName = deal ? getDealName(deal) : null;
    const dealRecordId = deal?.id.record_id ?? null;

    log.info({ callId, personName, dealName, dealRecordId }, 'Context resolved');

    const aiResult = await transcribeCall(call);

    const { personNote, dealNote } = formatNote({
      call, dealName,
      summary: aiResult?.summary ?? null,
      transcript: aiResult?.transcript ?? null,
    });

    const personNoteId = await attio.createNote({
      parentObject: 'people',
      parentRecordId: personRecordId,
      title: personNote.title,
      content: personNote.content,
    });

    if (personNoteId) {
      log.info({ callId, personName, noteId: personNoteId }, 'Person note created');
    }

    if (dealNote && dealRecordId) {
      const dealNoteId = await attio.createNote({
        parentObject: 'deals',
        parentRecordId: dealRecordId,
        title: dealNote.title,
        content: dealNote.content,
      });

      if (dealNoteId) {
        log.info({ callId, dealName, noteId: dealNoteId }, 'Deal note created');
      }
    }

    log.info({ callId, personName, dealName }, 'Call processing complete');
  }

  async function processCallManual(callId: string): Promise<ProcessResult> {
    try {
      log.info({ callId }, 'Manual processing started');
      const call = await cloudtalk.getCallDetails(callId);
      if (!call) return { success: false, error: `Nie znaleziono rozmowy ${callId} w CloudTalk` };

      if (call.duration < MIN_CALL_DURATION) {
        return { success: false, error: `Rozmowa za krótka (${call.duration}s < ${MIN_CALL_DURATION}s)` };
      }

      const phoneNumber = call.externalNumber;
      if (!phoneNumber) return { success: false, error: 'Brak numeru telefonu' };

      let person = await attio.findPersonByPhone(phoneNumber);
      if (!person && call.contactEmails.length > 0) {
        for (const email of call.contactEmails) {
          person = await attio.findPersonByEmail(email);
          if (person) break;
        }
      }
      if (!person) return { success: false, error: `Osoba ${phoneNumber} nie znaleziona w Attio` };

      const personName = getPersonName(person);
      const deal = await attio.pickBestDeal(person);
      const dealName = deal ? getDealName(deal) : null;

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
      if (personNoteId) notesCreated++;

      if (dealNote && deal) {
        const dealNoteId = await attio.createNote({
          parentObject: 'deals',
          parentRecordId: deal.id.record_id,
          title: dealNote.title,
          content: dealNote.content,
        });
        if (dealNoteId) notesCreated++;
      }

      return { success: true, personName, dealName: dealName ?? undefined, notesCreated };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Nieznany błąd';
      log.error({ callId, err }, 'Manual processing failed');
      return { success: false, error: message };
    }
  }

  async function webhookHandler(req: Request, res: Response): Promise<void> {
    const payload = req.body as CloudTalkWebhookPayload;

    if (!payload?.call_id && !payload?.call_uuid) {
      res.status(400).json({ error: 'Missing call_id or call_uuid' });
      return;
    }

    res.status(200).json({ status: 'accepted' });

    processCall(payload).catch(err => {
      const callId = payload.call_id ?? payload.call_uuid;
      if (callId) processedCalls.delete(callId);
      log.error({ err, payload }, 'Unhandled error in call processing — will retry on next webhook');
    });
  }

  return {
    webhookHandler,
    processCallManual,
    isCallProcessed,
    markCallProcessed,
  };
}
