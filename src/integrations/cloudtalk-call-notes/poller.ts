import type { Logger } from 'pino';
import type { CloudTalkClient } from '../../lib/org-context.js';

const POLL_INTERVAL = 2 * 60 * 1000;
const INITIAL_DELAY = 30 * 1000;
const MIN_DURATION = 30;
const LOOKBACK_ON_START = 5 * 60 * 1000;

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
      const calls = await cloudtalk.getCallsSince(lastCheck);
      const eligible = calls.filter(c => c.duration >= MIN_DURATION);

      if (eligible.length === 0) {
        log.info({ since: lastCheck.toISOString(), totalCalls: calls.length }, 'Poll: no new eligible calls');
        lastCheck = new Date();
        return;
      }

      log.info({ eligible: eligible.length, total: calls.length }, 'New calls found');

      let processed = 0;
      for (const call of eligible) {
        if (handler.isCallProcessed(call.id)) {
          log.debug({ callId: call.id }, 'Already processed, skipping');
          continue;
        }

        handler.markCallProcessed(call.id);
        log.info({ callId: call.id, duration: call.duration, phone: call.externalNumber }, 'Auto-processing call');

        const result = await handler.processCallManual(call.id);

        if (result.success) {
          log.info({ callId: call.id, personName: result.personName, dealName: result.dealName, notes: result.notesCreated }, 'Auto-processed successfully');
          processed++;
        } else {
          log.warn({ callId: call.id, error: result.error }, 'Auto-processing failed');
        }
      }

      log.info({ processed, skipped: eligible.length - processed }, 'Poll cycle complete');
      lastCheck = new Date();
    } catch (err) {
      log.error({ err }, 'Poll cycle error');
    }
  }

  return function startPoller(): void {
    log.info({ intervalMs: POLL_INTERVAL, initialDelayMs: INITIAL_DELAY }, 'Poller scheduled');

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
