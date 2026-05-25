import type { Logger } from 'pino';
import type { CloudTalkClient } from '../../lib/org-context.js';

const POLL_INTERVAL = 2 * 60 * 1000;
const INITIAL_DELAY = 30 * 1000;
const MIN_DURATION = 30;
const LOOKBACK_ON_START = 20 * 60 * 1000;

// Safety buffer: never advance lastCheck closer than this to "now".
// Must be >= longest expected call duration + CDR processing delay (~2 min).
// 20 min covers calls up to ~18 min, which handles >99% of business calls.
const LOOKBACK_BUFFER = 20 * 60 * 1000;

// Higher limit to cover the larger lookback window
const POLL_FETCH_LIMIT = 50;

export function createPoller(
  cloudtalk: CloudTalkClient,
  handler: {
    isCallProcessed: (callId: string) => boolean;
    markCallProcessed: (callId: string) => void;
    processCallManual: (callId: string) => Promise<{ success: boolean; personName?: string; dealName?: string; notesCreated?: number; error?: string }>;
  },
  log: Logger,
) {
  let lastCheck = new Date(Date.now() - LOOKBACK_ON_START);

  async function poll(): Promise<void> {
    try {
      const calls = await cloudtalk.getCallsSince(lastCheck, POLL_FETCH_LIMIT);
      const eligible = calls.filter(c => c.duration >= MIN_DURATION);

      // Always cap lastCheck at now - buffer so we re-check recent calls
      // that may still be in progress or pending CDR creation
      const safeCheckpoint = new Date(Date.now() - LOOKBACK_BUFFER);

      if (eligible.length === 0) {
        log.info({ since: lastCheck.toISOString(), totalCalls: calls.length }, 'Poll: no new eligible calls');
        if (safeCheckpoint > lastCheck) lastCheck = safeCheckpoint;
        return;
      }

      log.info({ eligible: eligible.length, total: calls.length }, 'New calls found');

      let processed = 0;
      for (const call of eligible) {
        if (handler.isCallProcessed(call.id)) {
          log.debug({ callId: call.id }, 'Already processed, skipping');
          continue;
        }

        log.info({ callId: call.id, duration: call.duration, phone: call.externalNumber }, 'Auto-processing call');

        const result = await handler.processCallManual(call.id);

        if (result.success) {
          handler.markCallProcessed(call.id);
          log.info({ callId: call.id, personName: result.personName, dealName: result.dealName, notes: result.notesCreated }, 'Auto-processed successfully');
          processed++;
        } else {
          log.warn({ callId: call.id, error: result.error }, 'Auto-processing failed, will retry next cycle');
        }
      }

      log.info({ processed, skipped: eligible.length - processed }, 'Poll cycle complete');
      if (safeCheckpoint > lastCheck) lastCheck = safeCheckpoint;
    } catch (err) {
      log.error({ err }, 'Poll cycle error');
    }
  }

  return function startPoller(): void {
    log.info({ intervalMs: POLL_INTERVAL, initialDelayMs: INITIAL_DELAY, lookbackBufferMs: LOOKBACK_BUFFER }, 'Poller scheduled');

    setTimeout(() => {
      log.info('Poller started');
      poll().catch(err => log.error({ err }, 'Initial poll failed'));
      const interval = setInterval(() => {
        poll().catch(err => log.error({ err }, 'Poll cycle failed'));
      }, POLL_INTERVAL);
      interval.unref();
    }, INITIAL_DELAY);
  };
}
