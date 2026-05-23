import type { Logger } from 'pino';
import * as openrouter from '../../lib/openrouter.js';
import type { CloudTalkClient } from '../../lib/org-context.js';
import type { CloudTalkCall } from '../../lib/cloudtalk.js';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createTranscriber(cloudtalk: CloudTalkClient, log: Logger) {
  return async function transcribeCall(
    call: CloudTalkCall,
  ): Promise<{ transcript: string; summary: string } | null> {
    if (!call.recorded) {
      log.info({ callId: call.id }, 'Call has no recording');
      return null;
    }

    await sleep(5000);

    let recording = await cloudtalk.downloadRecording(call.id);

    if (!recording) {
      log.info({ callId: call.id }, 'Recording not ready, retrying in 15s');
      await sleep(15000);
      recording = await cloudtalk.downloadRecording(call.id);
    }

    if (!recording) {
      log.warn({ callId: call.id }, 'Recording unavailable after retry');
      return null;
    }

    const callMeta = {
      direction: call.type,
      duration: call.duration,
      agentName: call.agentName,
    };

    // OpenRouter is a shared service (singleton) — not per-org
    const result = await openrouter.transcribeAndSummarize(recording, callMeta);
    if (!result) {
      log.error({ callId: call.id }, 'Transcription + summarization failed');
      return null;
    }

    return result;
  };
}
