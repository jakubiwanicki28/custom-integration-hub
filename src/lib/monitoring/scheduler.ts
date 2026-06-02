import { config } from '../../config.js';
import { logger } from '../logger.js';
import { metrics } from '../metrics.js';
import { createSlackClient } from '../slack.js';
import { createVercelClient } from '../vercel.js';
import { loadMonitoringConfig } from './config.js';
import { createVercelMonitor } from './vercel-monitor.js';
import { analyzeHourly, analyzeDaily, cleanupOldAnalyses } from './analyst.js';
import { formatAnomalyAlert, formatDailyDigest } from './reporter.js';
import type { VercelProjectHealth } from './types.js';

const log = logger.child({ lib: 'monitoring-scheduler' });

const HOURLY_INTERVAL = 60 * 60 * 1000;       // 1h
const MICRO_CHECK_INTERVAL = 5 * 60 * 1000;   // 5 min
const ALERT_THROTTLE_MS = 60 * 60 * 1000;     // max 1 alert per hour

export function startMonitoring(): () => void {
  const slackToken = process.env.VELOCY_SLACK_BOT_TOKEN || '';
  const monitoringConfig = loadMonitoringConfig();
  const channelId = config.monitoring.slackChannelId || monitoringConfig.slack.channelId;

  if (!slackToken || !channelId) {
    log.warn({ hasToken: !!slackToken, hasChannel: !!channelId }, 'Monitoring degraded: missing Slack token or channel ID — metrics collected, no Slack alerts');
    return () => {};
  }

  const slack = createSlackClient(slackToken, log.child({ lib: 'monitoring-slack' }));
  let stopping = false;
  let lastAlertTime = 0;

  let vercelHealth: VercelProjectHealth[] = [];
  let stopVercelMonitor: (() => void) | null = null;

  // Start Vercel health monitoring if configured
  if (config.monitoring.vercelApiToken) {
    const vercelClient = createVercelClient(
      config.monitoring.vercelApiToken,
      config.monitoring.vercelTeamId,
      log.child({ lib: 'vercel' }),
    );
    const vercelMonitor = createVercelMonitor(vercelClient, monitoringConfig.vercel.projects, log);
    stopVercelMonitor = vercelMonitor.startPolling(monitoringConfig.vercel.pollIntervalMs, (health) => {
      vercelHealth = health;
    });
    log.info({ projects: Object.values(monitoringConfig.vercel.projects).flat().length }, 'Vercel health monitor started');
  }

  // --- Hourly analysis ---

  async function runHourlyAnalysis(): Promise<void> {
    if (stopping) return;

    try {
      const current = metrics.getSnapshot(HOURLY_INTERVAL);
      const baseline = computeBaseline();

      const analysis = await analyzeHourly(current, baseline, vercelHealth);
      if (!analysis) return;

      log.info({ id: analysis.id, status: analysis.status, anomalies: analysis.anomalies.length }, 'Hourly analysis complete');

      // Only alert on anomaly/critical, with throttling
      if (analysis.status !== 'normal' && Date.now() - lastAlertTime >= ALERT_THROTTLE_MS) {
        const { blocks, text } = formatAnomalyAlert(analysis);
        const sent = await slack.postMessage(channelId, blocks, text);
        if (sent) {
          lastAlertTime = Date.now();
          log.info({ status: analysis.status }, 'Anomaly alert sent to Slack');
        }
      }
    } catch (err) {
      log.error({ err }, 'Hourly analysis failed — monitoring continues');
    }
  }

  // --- Daily digest ---

  async function runDailyDigest(): Promise<void> {
    if (stopping) return;

    try {
      const todaySnapshots = metrics.getDailySnapshots();
      if (todaySnapshots.length === 0) {
        log.info('No snapshots for daily digest, skipping');
        return;
      }

      const analysis = await analyzeDaily(todaySnapshots, vercelHealth);
      if (!analysis) return;

      const daySnapshot = analysis.snapshot;
      const { blocks, text } = formatDailyDigest(analysis, daySnapshot);
      const sent = await slack.postMessage(channelId, blocks, text);

      if (sent) {
        log.info('Daily digest sent to Slack');
      }
    } catch (err) {
      log.error({ err }, 'Daily digest failed — monitoring continues');
    }
  }

  // --- Micro-check (5 min) ---

  async function runMicroCheck(): Promise<void> {
    if (stopping) return;

    try {
      // Lightweight: check last 15 minutes for critical issues
      const recent = metrics.getSnapshot(15 * 60 * 1000);

      // Check for high error rate
      const errorRate = recent.totals.total > 0
        ? recent.totals.error / recent.totals.total
        : 0;

      // Check if during business hours with zero activity
      const warsawHour = parseInt(
        new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Warsaw', hour: 'numeric', hour12: false }).format(new Date()),
        10,
      );
      const isBusinessHours = warsawHour >= 8 && warsawHour < 20;
      const isWeekday = new Date().getDay() >= 1 && new Date().getDay() <= 5;

      // Only escalate if: error rate > 50% with at least 3 events, OR zero events during peak hours
      const criticalErrorRate = errorRate > 0.5 && recent.totals.total >= 3;
      const zeroActivity = isBusinessHours && isWeekday && recent.totals.total === 0 && recent.http.total === 0;

      if (!criticalErrorRate && !zeroActivity) return;

      // Throttle: still max 1 alert per hour
      if (Date.now() - lastAlertTime < ALERT_THROTTLE_MS) return;

      // Run a quick AI analysis for the critical situation
      const baseline = computeBaseline();
      const analysis = await analyzeHourly(recent, baseline, vercelHealth);
      if (!analysis || analysis.status === 'normal') return;

      // Override type to 'micro'
      analysis.type = 'micro';

      const { blocks, text } = formatAnomalyAlert(analysis);
      const sent = await slack.postMessage(channelId, blocks, text);
      if (sent) {
        lastAlertTime = Date.now();
        log.info({ reason: criticalErrorRate ? 'high_error_rate' : 'zero_activity' }, 'Micro-check alert sent');
      }
    } catch (err) {
      log.error({ err }, 'Micro-check failed — monitoring continues');
    }
  }

  // --- Baseline computation ---

  function computeBaseline(): ReturnType<typeof metrics.getSnapshot> | null {
    const currentHour = new Date().getUTCHours();
    const historicalSnapshots = metrics.getSnapshotsForHour(currentHour, 7);

    if (historicalSnapshots.length === 0) return null;

    // Average the snapshots
    const avg = historicalSnapshots.reduce((acc, hs) => {
      acc.totals.total += hs.snapshot.totals.total;
      acc.totals.success += hs.snapshot.totals.success;
      acc.totals.error += hs.snapshot.totals.error;
      acc.http.total += hs.snapshot.http.total;
      acc.http.errors += hs.snapshot.http.errors;
      return acc;
    }, {
      totals: { total: 0, success: 0, error: 0, skip: 0, dedup: 0 },
      http: { total: 0, errors: 0, avgDurationMs: 0, byStatus: {} as Record<string, number> },
      byIntegration: {} as Record<string, { total: number; success: number; error: number; skip: number; dedup: number; avgDurationMs: number; maxDurationMs: number; byOrg: Record<string, number> }>,
      windowMs: HOURLY_INTERVAL,
      from: Date.now() - HOURLY_INTERVAL,
      to: Date.now(),
    });

    const n = historicalSnapshots.length;
    avg.totals.total = Math.round(avg.totals.total / n);
    avg.totals.success = Math.round(avg.totals.success / n);
    avg.totals.error = Math.round(avg.totals.error / n);
    avg.http.total = Math.round(avg.http.total / n);
    avg.http.errors = Math.round(avg.http.errors / n);

    return avg;
  }

  // --- Daily digest scheduling (23:00 Warsaw time) ---

  function scheduleDailyDigest(): ReturnType<typeof setTimeout> {
    const tz = monitoringConfig.slack.timezone;
    const targetHour = monitoringConfig.slack.dailyDigestHour;

    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const currentHour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);
    const currentMinute = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);

    let msUntilTarget: number;
    if (currentHour < targetHour) {
      msUntilTarget = ((targetHour - currentHour) * 60 - currentMinute) * 60 * 1000;
    } else {
      // Schedule for tomorrow (also handles currentHour === targetHour)
      msUntilTarget = ((24 - currentHour + targetHour) * 60 - currentMinute) * 60 * 1000;
    }
    // Safety: if computed time is in the past or too close, push to tomorrow
    if (msUntilTarget < 60_000) msUntilTarget += 24 * 60 * 60 * 1000;

    log.info({ targetHour, tz, msUntilTarget: Math.round(msUntilTarget / 60_000) }, 'Daily digest scheduled (minutes from now)');

    const timer = setTimeout(async () => {
      await runDailyDigest();
      // Re-schedule for tomorrow
      if (!stopping) {
        dailyTimer = scheduleDailyDigest();
      }
    }, msUntilTarget);
    timer.unref();
    return timer;
  }

  // --- Start all schedules ---

  // Initial delay: run first hourly analysis 5 minutes after startup (give integrations time to generate events)
  const initialDelay = setTimeout(() => {
    runHourlyAnalysis();
  }, 5 * 60 * 1000);
  initialDelay.unref();

  const hourlyInterval = setInterval(() => {
    runHourlyAnalysis();
  }, HOURLY_INTERVAL);
  hourlyInterval.unref();

  const microInterval = setInterval(() => {
    runMicroCheck();
  }, MICRO_CHECK_INTERVAL);
  microInterval.unref();

  let dailyTimer = scheduleDailyDigest();

  // Cleanup old analyses on startup
  cleanupOldAnalyses();

  log.info({ channelId }, 'Monitoring started — hourly analysis, daily digest, 5-min micro-checks');

  // Return stop function
  return () => {
    stopping = true;
    clearTimeout(initialDelay);
    clearInterval(hourlyInterval);
    clearInterval(microInterval);
    clearTimeout(dailyTimer);
    if (stopVercelMonitor) stopVercelMonitor();
    log.info('Monitoring stopped');
  };
}
