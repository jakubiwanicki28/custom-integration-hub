import { readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { chatCompletion } from '../openrouter.js';
import { logger } from '../logger.js';
import { buildHourlyAnalysisPrompt, buildDailyDigestPrompt, promptToText } from './prompts.js';
import type { MetricsSnapshot, HourlySnapshot } from '../metrics.js';
import type { AnalysisResult, PersistedAnalysis, VercelProjectHealth } from './types.js';

const log = logger.child({ lib: 'monitoring-analyst' });

const ANALYSES_DIR = join(process.cwd(), 'data', 'analyses');
const RETENTION_DAYS = 30;
const MODEL = 'google/gemini-2.5-flash-lite';

function parseAIResponse(raw: string): { status: string; summary: string; anomalies: AnalysisResult['anomalies']; recommendations?: string[] } | null {
  try {
    // Strip markdown code fences if present
    const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    return JSON.parse(cleaned);
  } catch {
    log.warn({ raw: raw.slice(0, 300) }, 'Failed to parse AI response as JSON');
    return null;
  }
}

function generateAnalysisId(type: 'hourly' | 'daily' | 'micro'): string {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  if (type === 'daily') return `${dateStr}-daily`;
  const hour = String(now.getUTCHours()).padStart(2, '0');
  if (type === 'micro') return `${dateStr}T${hour}-micro-${Date.now() % 10000}`;
  return `${dateStr}T${hour}`;
}

export async function analyzeHourly(
  current: MetricsSnapshot,
  baseline: MetricsSnapshot | null,
  vercelHealth: VercelProjectHealth[],
): Promise<PersistedAnalysis | null> {
  try {
    const messages = buildHourlyAnalysisPrompt(current, baseline, vercelHealth);
    const promptText = promptToText(messages);

    const raw = await chatCompletion(MODEL, messages);
    if (!raw) {
      log.warn('AI returned null for hourly analysis');
      return null;
    }

    const parsed = parseAIResponse(raw);
    if (!parsed) return null;

    const analysis: PersistedAnalysis = {
      id: generateAnalysisId('hourly'),
      timestamp: new Date().toISOString(),
      type: 'hourly',
      status: (parsed.status as AnalysisResult['status']) || 'normal',
      summary: parsed.summary || '',
      anomalies: parsed.anomalies || [],
      recommendations: parsed.recommendations,
      snapshot: current,
      prompt: promptText,
      rawResponse: raw,
    };

    persistAnalysis(analysis);
    return analysis;
  } catch (err) {
    log.error({ err }, 'Hourly analysis failed');
    return null;
  }
}

export async function analyzeDaily(
  hourlySnapshots: HourlySnapshot[],
  vercelHealth: VercelProjectHealth[],
): Promise<PersistedAnalysis | null> {
  try {
    const messages = buildDailyDigestPrompt(hourlySnapshots, vercelHealth);
    const promptText = promptToText(messages);

    const raw = await chatCompletion(MODEL, messages);
    if (!raw) {
      log.warn('AI returned null for daily analysis');
      return null;
    }

    const parsed = parseAIResponse(raw);
    if (!parsed) return null;

    // Build an aggregate snapshot for the day
    const daySnapshot: MetricsSnapshot = {
      windowMs: 24 * 60 * 60 * 1000,
      from: Date.now() - 24 * 60 * 60 * 1000,
      to: Date.now(),
      totals: { total: 0, success: 0, error: 0, skip: 0, dedup: 0 },
      byIntegration: {},
      http: { total: 0, errors: 0, avgDurationMs: 0, byStatus: {} },
    };

    for (const hs of hourlySnapshots) {
      daySnapshot.totals.total += hs.snapshot.totals.total;
      daySnapshot.totals.success += hs.snapshot.totals.success;
      daySnapshot.totals.error += hs.snapshot.totals.error;
      daySnapshot.totals.skip += hs.snapshot.totals.skip;
      daySnapshot.totals.dedup += hs.snapshot.totals.dedup;
      daySnapshot.http.total += hs.snapshot.http.total;
      daySnapshot.http.errors += hs.snapshot.http.errors;
    }

    const analysis: PersistedAnalysis = {
      id: generateAnalysisId('daily'),
      timestamp: new Date().toISOString(),
      type: 'daily',
      status: (parsed.status as AnalysisResult['status']) || 'normal',
      summary: parsed.summary || '',
      anomalies: parsed.anomalies || [],
      recommendations: parsed.recommendations,
      snapshot: daySnapshot,
      prompt: promptText,
      rawResponse: raw,
    };

    persistAnalysis(analysis);
    return analysis;
  } catch (err) {
    log.error({ err }, 'Daily analysis failed');
    return null;
  }
}

// --- Persistence ---

function persistAnalysis(analysis: PersistedAnalysis): void {
  try {
    if (!existsSync(ANALYSES_DIR)) {
      mkdirSync(ANALYSES_DIR, { recursive: true });
    }

    const dateStr = analysis.timestamp.slice(0, 10);
    const filePath = join(ANALYSES_DIR, `${dateStr}.json`);

    let analyses: PersistedAnalysis[] = [];
    try {
      if (existsSync(filePath)) {
        analyses = JSON.parse(readFileSync(filePath, 'utf-8'));
      }
    } catch { /* start fresh */ }

    // Prevent duplicate analyses (e.g. after process restart within same hour)
    if (analyses.some(a => a.id === analysis.id)) {
      log.info({ id: analysis.id }, 'Analysis already persisted, skipping duplicate');
      return;
    }

    analyses.push(analysis);

    const tmpPath = filePath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(analyses, null, 2));
    renameSync(tmpPath, filePath);

    log.info({ id: analysis.id, status: analysis.status, type: analysis.type }, 'Analysis persisted');
  } catch (err) {
    log.error({ err }, 'Failed to persist analysis');
  }
}

export function loadAnalyses(date?: string): PersistedAnalysis[] {
  try {
    const d = date ?? new Date().toISOString().slice(0, 10);
    const filePath = join(ANALYSES_DIR, `${d}.json`);
    if (!existsSync(filePath)) return [];
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    log.warn({ err, date }, 'Failed to load analyses');
    return [];
  }
}

export function cleanupOldAnalyses(): void {
  try {
    if (!existsSync(ANALYSES_DIR)) return;

    const files = readdirSync(ANALYSES_DIR);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    let deleted = 0;
    for (const file of files) {
      if (!file.endsWith('.json') || file.endsWith('.tmp')) continue;
      const dateStr = file.replace('.json', '');
      if (dateStr < cutoffStr) {
        unlinkSync(join(ANALYSES_DIR, file));
        deleted++;
      }
    }

    if (deleted > 0) log.info({ deleted }, 'Old analysis files cleaned up');
  } catch (err) {
    log.warn({ err }, 'Analysis cleanup failed');
  }
}
