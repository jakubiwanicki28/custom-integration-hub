import { createLogger } from '../../lib/logger.js';
import * as cloudtalk from '../../lib/cloudtalk.js';
import * as openrouter from '../../lib/openrouter.js';
import type { CloudTalkCall } from '../../lib/cloudtalk.js';

const log = createLogger('cloudtalk-call-notes:transcribe');

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function transcribeCall(
  call: CloudTalkCall,
): Promise<{ transcript: string; summary: string } | null> {
  if (!call.recorded) {
    log.info({ callId: call.id }, 'Call has no recording');
    return null;
  }

  // Wait a bit for recording to become available after call ends
  await sleep(5000);

  let recording = await cloudtalk.downloadRecording(call.id);

  // Retry once if not available yet
  if (!recording) {
    log.info({ callId: call.id }, 'Recording not ready, retrying in 15s');
    await sleep(15000);
    recording = await cloudtalk.downloadRecording(call.id);
  }

  if (!recording) {
    log.warn({ callId: call.id }, 'Recording unavailable after retry');
    return null;
  }

  // Single-pass: transcribe + summarize in one API call
  const callMeta = {
    direction: call.type,
    duration: call.duration,
    agentName: call.agentName,
  };

  const result = await openrouter.transcribeAndSummarize(recording, callMeta);
  if (!result) {
    log.error({ callId: call.id }, 'Transcription + summarization failed');
    return null;
  }

  return result;
}
