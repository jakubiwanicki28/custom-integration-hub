import { readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { logger } from './logger.js';

const log = logger.child({ lib: 'metrics' });

// --- Types ---

export interface MetricEvent {
  timestamp: number;
  integration: string;
  org: string;
  event: string;          // 'success' | 'error' | 'skip' | 'dedup'
  durationMs?: number;
  meta?: Record<string, string>;
}

export interface IntegrationStats {
  total: number;
  success: number;
  error: number;
  skip: number;
  dedup: number;
  avgDurationMs: number;
  maxDurationMs: number;
  byOrg: Record<string, number>;
}

export interface MetricsSnapshot {
  windowMs: number;
  from: number;
  to: number;
  totals: { total: number; success: number; error: number; skip: number; dedup: number };
  byIntegration: Record<string, IntegrationStats>;
  http: { total: number; errors: number; avgDurationMs: number; byStatus: Record<string, number> };
}

export interface HourlySnapshot {
  hour: string;          // ISO 8601 hour start, e.g. '2026-06-02T14:00:00.000Z'
  timestamp: number;
  snapshot: MetricsSnapshot;
}

interface DailyFile {
  date: string;
  snapshots: HourlySnapshot[];
}

// --- Constants ---

const METRICS_DIR = join(process.cwd(), 'data', 'metrics');
const BUFFER_MAX_AGE_MS = 24 * 60 * 60 * 1000;  // 24h
const BUFFER_MAX_SIZE = 50_000;
const RETENTION_DAYS = 30;
const PERSIST_INTERVAL_MS = 60 * 60 * 1000;  // 1h
const EVICTION_THROTTLE_MS = 60 * 1000;       // 1min

// --- MetricsCollector ---

class MetricsCollector {
  private events: MetricEvent[] = [];
  private lastEviction = 0;
  private persistInterval: ReturnType<typeof setInterval> | null = null;
  private lastPersistedHour = '';

  /** Record a metric event. Never throws. */
  track(event: Omit<MetricEvent, 'timestamp'>): void {
    try {
      this.events.push({ ...event, timestamp: Date.now() });
      this.maybeEvict();
    } catch {
      // Swallow — monitoring must never crash the hub
    }
  }

  /** Aggregate events within a time window into a snapshot. */
  getSnapshot(windowMs = 3_600_000): MetricsSnapshot {
    const now = Date.now();
    const from = now - windowMs;
    const filtered = this.events.filter(e => e.timestamp >= from);

    const totals = { total: 0, success: 0, error: 0, skip: 0, dedup: 0 };
    const byIntegration: Record<string, IntegrationStats> = {};
    const http = { total: 0, errors: 0, totalDuration: 0, byStatus: {} as Record<string, number> };

    for (const e of filtered) {
      if (e.integration === '_http') {
        http.total++;
        if (e.event === 'error') http.errors++;
        if (e.durationMs) http.totalDuration += e.durationMs;
        const status = e.meta?.status ?? 'unknown';
        http.byStatus[status] = (http.byStatus[status] ?? 0) + 1;
        continue;
      }

      totals.total++;
      if (e.event === 'success') totals.success++;
      else if (e.event === 'error') totals.error++;
      else if (e.event === 'skip') totals.skip++;
      else if (e.event === 'dedup') totals.dedup++;

      if (!byIntegration[e.integration]) {
        byIntegration[e.integration] = { total: 0, success: 0, error: 0, skip: 0, dedup: 0, avgDurationMs: 0, maxDurationMs: 0, byOrg: {} };
      }
      const stats = byIntegration[e.integration];
      stats.total++;
      if (e.event === 'success') stats.success++;
      else if (e.event === 'error') stats.error++;
      else if (e.event === 'skip') stats.skip++;
      else if (e.event === 'dedup') stats.dedup++;

      stats.byOrg[e.org] = (stats.byOrg[e.org] ?? 0) + 1;
      if (e.durationMs) {
        if (e.durationMs > stats.maxDurationMs) stats.maxDurationMs = e.durationMs;
        // Track for average computation (stored temporarily, cleaned up below)
        (stats as IntegrationStats & { _totalDuration?: number; _durationCount?: number })._totalDuration =
          ((stats as IntegrationStats & { _totalDuration?: number })._totalDuration ?? 0) + e.durationMs;
        (stats as IntegrationStats & { _totalDuration?: number; _durationCount?: number })._durationCount =
          ((stats as IntegrationStats & { _durationCount?: number })._durationCount ?? 0) + 1;
      }
    }

    // Compute averages from accumulated totals
    for (const stats of Object.values(byIntegration)) {
      const s = stats as IntegrationStats & { _totalDuration?: number; _durationCount?: number };
      if (s._durationCount && s._durationCount > 0) {
        stats.avgDurationMs = Math.round(s._totalDuration! / s._durationCount);
      }
      delete s._totalDuration;
      delete s._durationCount;
    }

    return {
      windowMs,
      from,
      to: now,
      totals,
      byIntegration,
      http: {
        total: http.total,
        errors: http.errors,
        avgDurationMs: http.total > 0 ? Math.round(http.totalDuration / http.total) : 0,
        byStatus: http.byStatus,
      },
    };
  }

  /** Get raw events within a time window. */
  getEvents(windowMs = 3_600_000): MetricEvent[] {
    const from = Date.now() - windowMs;
    return this.events.filter(e => e.timestamp >= from);
  }

  /** Get persisted daily snapshots for a date (YYYY-MM-DD). */
  getDailySnapshots(date?: string): HourlySnapshot[] {
    const d = date ?? new Date().toISOString().slice(0, 10);
    const filePath = join(METRICS_DIR, `${d}.json`);
    try {
      if (!existsSync(filePath)) return [];
      const data = JSON.parse(readFileSync(filePath, 'utf-8')) as DailyFile;
      return data.snapshots ?? [];
    } catch (err) {
      log.warn({ err, date: d }, 'Failed to read daily snapshots');
      return [];
    }
  }

  /** Get hourly snapshots for last N days (for baseline computation). */
  getSnapshotsForHour(hour: number, daysBack = 7): HourlySnapshot[] {
    const results: HourlySnapshot[] = [];
    const now = new Date();

    for (let i = 1; i <= daysBack; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      const snapshots = this.getDailySnapshots(dateStr);
      for (const s of snapshots) {
        const h = new Date(s.hour).getUTCHours();
        if (h === hour) results.push(s);
      }
    }

    return results;
  }

  /** Start hourly persistence. Call once after server starts. */
  startPersistence(): void {
    if (this.persistInterval) return;

    // Cleanup old files on startup
    this.cleanupOldFiles();

    this.persistInterval = setInterval(() => {
      this.persistCurrentHour();
    }, PERSIST_INTERVAL_MS);
    this.persistInterval.unref();

    log.info('Metrics persistence started (hourly snapshots)');
  }

  /** Total event count in buffer (for diagnostics). */
  get bufferSize(): number {
    return this.events.length;
  }

  // --- Internal ---

  private maybeEvict(): void {
    const now = Date.now();
    if (now - this.lastEviction < EVICTION_THROTTLE_MS) return;
    this.lastEviction = now;

    const cutoff = now - BUFFER_MAX_AGE_MS;
    const beforeLen = this.events.length;

    // Remove events older than 24h
    if (this.events.length > 0 && this.events[0].timestamp < cutoff) {
      const idx = this.events.findIndex(e => e.timestamp >= cutoff);
      if (idx > 0) this.events.splice(0, idx);
      else if (idx === -1) this.events.length = 0;
    }

    // Hard cap
    if (this.events.length > BUFFER_MAX_SIZE) {
      this.events.splice(0, this.events.length - BUFFER_MAX_SIZE);
    }

    if (beforeLen !== this.events.length) {
      log.debug({ before: beforeLen, after: this.events.length }, 'Metrics buffer eviction');
    }
  }

  private persistCurrentHour(): void {
    try {
      const now = new Date();
      const hourKey = now.toISOString().slice(0, 13) + ':00:00.000Z';

      // Don't persist the same hour twice
      if (hourKey === this.lastPersistedHour) return;
      this.lastPersistedHour = hourKey;

      const snapshot = this.getSnapshot(PERSIST_INTERVAL_MS);
      const hourlySnapshot: HourlySnapshot = {
        hour: hourKey,
        timestamp: Date.now(),
        snapshot,
      };

      const dateStr = now.toISOString().slice(0, 10);
      const filePath = join(METRICS_DIR, `${dateStr}.json`);

      // Ensure directory exists
      if (!existsSync(METRICS_DIR)) {
        mkdirSync(METRICS_DIR, { recursive: true });
      }

      // Load existing or create new
      let daily: DailyFile;
      try {
        if (existsSync(filePath)) {
          daily = JSON.parse(readFileSync(filePath, 'utf-8')) as DailyFile;
        } else {
          daily = { date: dateStr, snapshots: [] };
        }
      } catch {
        daily = { date: dateStr, snapshots: [] };
      }

      // Prevent duplicate snapshots (e.g. after PM2 restart within same hour)
      if (daily.snapshots.some(s => s.hour === hourKey)) {
        this.lastPersistedHour = hourKey;
        return;
      }

      daily.snapshots.push(hourlySnapshot);

      // Atomic write: write to temp file, then rename
      const tmpPath = filePath + '.tmp';
      writeFileSync(tmpPath, JSON.stringify(daily, null, 2));
      renameSync(tmpPath, filePath);

      log.info({ hour: hourKey, events: snapshot.totals.total, httpRequests: snapshot.http.total }, 'Hourly snapshot persisted');
    } catch (err) {
      log.error({ err }, 'Failed to persist hourly snapshot');
    }
  }

  private cleanupOldFiles(): void {
    try {
      if (!existsSync(METRICS_DIR)) return;

      const files = readdirSync(METRICS_DIR);
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
      const cutoffStr = cutoff.toISOString().slice(0, 10);

      let deleted = 0;
      for (const file of files) {
        if (!file.endsWith('.json') || file.endsWith('.tmp')) continue;
        const dateStr = file.replace('.json', '');
        if (dateStr < cutoffStr) {
          unlinkSync(join(METRICS_DIR, file));
          deleted++;
        }
      }

      if (deleted > 0) {
        log.info({ deleted }, 'Old metrics files cleaned up');
      }
    } catch (err) {
      log.warn({ err }, 'Metrics cleanup failed');
    }
  }
}

// --- Singleton ---

export const metrics = new MetricsCollector();
