import type { Request, Response } from 'express';
import { createLogger } from '../../lib/logger.js';
import * as cloudtalk from '../../lib/cloudtalk.js';
import * as attio from '../../lib/attio.js';
import { transcribeCall } from './transcribe.js';
import { formatNote } from './summarize.js';
import type { CloudTalkWebhookPayload } from './types.js';

const log = createLogger('cloudtalk-call-notes');

// Simple idempotency: track processed call IDs (1h TTL)
const processedCalls = new Map<string, number>();
const IDEMPOTENCY_TTL = 60 * 60 * 1000; // 1 hour

function cleanupProcessedCalls() {
  const now = Date.now();
  for (const [id, timestamp] of processedCalls) {
    if (now - timestamp > IDEMPOTENCY_TTL) {
      processedCalls.delete(id);
    }
  }
}

// Clean up every 10 minutes
setInterval(cleanupProcessedCalls, 10 * 60 * 1000);

const MIN_CALL_DURATION = 30; // seconds

async function processCall(payload: CloudTalkWebhookPayload): Promise<void> {
  const callId = payload.call_id ?? payload.call_uuid;
  if (!callId) {
    log.error({ payload }, 'No call_id in webhook payload');
    return;
  }

  // Idempotency check
  if (processedCalls.has(callId)) {
    log.info({ callId }, 'Call already processed, skipping');
    return;
  }
  processedCalls.set(callId, Date.now());

  log.info({ callId }, 'Processing call');

  // 1. Fetch full call details from CloudTalk
  const call = await cloudtalk.getCallDetails(callId);
  if (!call) {
    log.error({ callId }, 'Could not fetch call details');
    return;
  }

  // 2. Skip very short calls
  if (call.duration < MIN_CALL_DURATION) {
    log.info({ callId, duration: call.duration }, 'Call too short, skipping');
    return;
  }

  // 3. Find person in Attio by phone number
  const phoneNumber = call.externalNumber || payload.phone_number;
  if (!phoneNumber) {
    log.error({ callId }, 'No phone number available');
    return;
  }

  let person = await attio.findPersonByPhone(phoneNumber);

  // Fallback: try email if phone didn't match and CloudTalk has contact emails
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
  const personName = attio.getPersonName(person);

  // 4. Find best deal for context
  const deal = await attio.pickBestDeal(person);
  const dealName = deal ? attio.getDealName(deal) : null;
  const dealRecordId = deal?.id.record_id ?? null;

  log.info({ callId, personName, dealName, dealRecordId }, 'Context resolved');

  // 5. Transcribe and summarize
  const aiResult = await transcribeCall(call);

  // 6. Format notes
  const { personNote, dealNote } = formatNote({
    call,
    dealName,
    summary: aiResult?.summary ?? null,
    transcript: aiResult?.transcript ?? null,
  });

  // 7. Create notes in Attio (Person + Deal)
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

// Manual trigger for test panel — returns result instead of void
export interface ProcessResult {
  success: boolean;
  personName?: string;
  dealName?: string;
  notesCreated?: number;
  error?: string;
}

export async function processCallManual(callId: string): Promise<ProcessResult> {
  try {
    log.info({ callId }, 'Manual processing started');
    const call = await cloudtalk.getCallDetails(callId);
    if (!call) return { success: false, error: `Nie znaleziono rozmowy ${callId} w CloudTalk` };

    log.info({ callId, foundId: call.id, duration: call.duration, phone: call.externalNumber }, 'Call found');

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

    const personName = attio.getPersonName(person);
    const deal = await attio.pickBestDeal(person);
    const dealName = deal ? attio.getDealName(deal) : null;

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

export async function webhookHandler(req: Request, res: Response): Promise<void> {
  const payload = req.body as CloudTalkWebhookPayload;

  // Respond immediately so CloudTalk doesn't retry
  res.status(200).json({ status: 'accepted' });

  // Process asynchronously
  processCall(payload).catch(err => {
    log.error({ err, payload }, 'Unhandled error in call processing');
  });
}
