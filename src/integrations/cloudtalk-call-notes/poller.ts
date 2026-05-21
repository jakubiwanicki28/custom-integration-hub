import { createLogger } from '../../lib/logger.js';
import { getCallsSince } from '../../lib/cloudtalk.js';
import { isCallProcessed, markCallProcessed, processCallManual } from './handler.js';

const log = createLogger('cloudtalk-call-notes:poller');

const POLL_INTERVAL = 2 * 60 * 1000; // 2 minutes
const INITIAL_DELAY = 30 * 1000;     // 30s after server start
const MIN_DURATION = 30;              // seconds
const LOOKBACK_ON_START = 5 * 60 * 1000; // 5 minutes on first poll

let lastCheck = new Date(Date.now() - LOOKBACK_ON_START);

async function poll(): Promise<void> {
  try {
    const calls = await getCallsSince(lastCheck);
    const eligible = calls.filter(c => c.duration >= MIN_DURATION);

    if (eligible.length === 0) {
      log.info({ since: lastCheck.toISOString(), totalCalls: calls.length }, 'Poll: no new eligible calls');
      lastCheck = new Date();
      return;
    }

    log.info({ eligible: eligible.length, total: calls.length }, 'New calls found');

    let processed = 0;
    for (const call of eligible) {
      if (isCallProcessed(call.id)) {
        log.debug({ callId: call.id }, 'Already processed, skipping');
        continue;
      }

      markCallProcessed(call.id);
      log.info({ callId: call.id, duration: call.duration, phone: call.externalNumber }, 'Auto-processing call');

      const result = await processCallManual(call.id);

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

export function startPoller(): void {
  log.info({ intervalMs: POLL_INTERVAL, initialDelayMs: INITIAL_DELAY }, 'Poller scheduled');

  setTimeout(() => {
    log.info('Poller started');
    poll().catch(err => log.error({ err }, 'Initial poll failed'));
    const interval = setInterval(() => {
      poll().catch(err => log.error({ err }, 'Poll cycle failed'));
    }, POLL_INTERVAL);
    interval.unref();
  }, INITIAL_DELAY);
}
