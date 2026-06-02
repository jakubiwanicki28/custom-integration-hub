import type { MetricsSnapshot } from '../metrics.js';
import type { VercelProjectHealth } from './types.js';

function formatSnapshot(snapshot: MetricsSnapshot, label: string): string {
  const lines: string[] = [`=== ${label} ===`];
  const { totals, byIntegration, http } = snapshot;

  lines.push(`Integration events: ${totals.total} total (${totals.success} ok, ${totals.error} err, ${totals.skip} skip, ${totals.dedup} dedup)`);
  lines.push(`HTTP requests: ${http.total} total, ${http.errors} errors, avg ${http.avgDurationMs}ms`);

  if (Object.keys(http.byStatus).length > 0) {
    const statusParts = Object.entries(http.byStatus).map(([s, c]) => `${s}:${c}`).join(', ');
    lines.push(`HTTP by status: ${statusParts}`);
  }

  for (const [name, stats] of Object.entries(byIntegration)) {
    const orgParts = Object.entries(stats.byOrg).map(([o, c]) => `${o}:${c}`).join(', ');
    lines.push(`  ${name}: ${stats.total} total (${stats.success} ok, ${stats.error} err, ${stats.skip} skip) avg ${stats.avgDurationMs}ms max ${stats.maxDurationMs}ms [${orgParts}]`);
  }

  return lines.join('\n');
}

function formatVercelHealth(projects: VercelProjectHealth[]): string {
  if (projects.length === 0) return '';

  const lines = ['=== VERCEL HEALTH ==='];
  for (const p of projects) {
    const ago = p.lastDeployAt ? `${Math.round((Date.now() - p.lastDeployAt) / 60_000)}min ago` : 'never';
    let line = `${p.label} (${p.org}): ${p.state} — last deploy ${ago}`;
    if (p.state === 'ERROR' && p.errorMessage) {
      line += ` — ${p.errorMessage}`;
    }
    if (p.branch) line += ` [${p.branch}]`;
    lines.push(line);
  }
  return lines.join('\n');
}

const SYSTEM_PROMPT = `You are a monitoring analyst for Custom Integration Hub — a business automation server handling CRM syncs, lead intake, call transcription, deploy notifications, and Slack alerts for multiple organizations.

Organizations:
- ww-partners: consulting firm (Akademia Biznesu campaign). Active integrations: lead-intake, calendly-booking-sync, cloudtalk-call-notes, slack-lead-notifications
- velocy: software house. Active integrations: lead-intake, slack-lead-notifications
- bookclinic: SaaS medical clinic app. Active integrations: vercel-deploy-notifications

Business hours: 8:00-20:00 CET (leads from Meta ads). Weekends: lower volume but not zero.
cloudtalk-call-notes: business hours only (9-17 Mon-Fri).

Analyze the metrics and identify anomalies. Be terse and precise. Respond in JSON only.`;

export function buildHourlyAnalysisPrompt(
  current: MetricsSnapshot,
  baseline: MetricsSnapshot | null,
  vercelHealth: VercelProjectHealth[],
): Array<{ role: string; content: string }> {
  const now = new Date();
  const hour = now.getUTCHours();
  const day = now.toLocaleDateString('en-US', { weekday: 'long' });

  let userContent = `Time: ${day} ${hour}:00 UTC\n\n`;
  userContent += formatSnapshot(current, 'CURRENT HOUR');

  if (baseline) {
    userContent += '\n\n' + formatSnapshot(baseline, 'BASELINE (avg same hour last 7 days)');
  } else {
    userContent += '\n\nBASELINE: Not available yet (cold start, < 7 days of data)';
  }

  const vercelSection = formatVercelHealth(vercelHealth);
  if (vercelSection) userContent += '\n\n' + vercelSection;

  userContent += `\n\nRespond with JSON:
{
  "status": "normal" | "anomaly" | "critical",
  "summary": "1-2 sentences in Polish describing the situation",
  "anomalies": [{ "metric": "integration/org", "expected": "value", "actual": "value", "severity": "low|medium|high" }]
}
If everything is normal, set status to "normal" and anomalies to [].`;

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];
}

export function buildDailyDigestPrompt(
  hourlySnapshots: Array<{ hour: string; snapshot: MetricsSnapshot }>,
  vercelHealth: VercelProjectHealth[],
): Array<{ role: string; content: string }> {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const day = now.toLocaleDateString('en-US', { weekday: 'long' });

  let userContent = `Daily digest for ${day} ${dateStr}\n\n`;

  // Aggregate totals across all hours
  let totalEvents = 0, totalSuccess = 0, totalError = 0, totalHttp = 0, totalHttpErr = 0;
  const byIntegration: Record<string, { total: number; success: number; error: number }> = {};

  for (const { hour, snapshot } of hourlySnapshots) {
    totalEvents += snapshot.totals.total;
    totalSuccess += snapshot.totals.success;
    totalError += snapshot.totals.error;
    totalHttp += snapshot.http.total;
    totalHttpErr += snapshot.http.errors;

    for (const [name, stats] of Object.entries(snapshot.byIntegration)) {
      if (!byIntegration[name]) byIntegration[name] = { total: 0, success: 0, error: 0 };
      byIntegration[name].total += stats.total;
      byIntegration[name].success += stats.success;
      byIntegration[name].error += stats.error;
    }
  }

  userContent += `DAY TOTALS:\n`;
  userContent += `Integration events: ${totalEvents} (${totalSuccess} ok, ${totalError} err)\n`;
  userContent += `HTTP requests: ${totalHttp} (${totalHttpErr} errors)\n`;
  userContent += `Hours with data: ${hourlySnapshots.length}\n\n`;

  for (const [name, stats] of Object.entries(byIntegration)) {
    userContent += `  ${name}: ${stats.total} total (${stats.success} ok, ${stats.error} err)\n`;
  }

  // Hourly activity pattern
  userContent += '\nHOURLY PATTERN (events per hour):\n';
  for (const { hour, snapshot } of hourlySnapshots) {
    const h = new Date(hour).getUTCHours();
    userContent += `  ${String(h).padStart(2, '0')}:00 — ${snapshot.totals.total} events (${snapshot.totals.error} err)\n`;
  }

  const vercelSection = formatVercelHealth(vercelHealth);
  if (vercelSection) userContent += '\n' + vercelSection;

  userContent += `\n\nProvide a daily summary in Polish. Include:
1. Overall health assessment
2. Notable patterns or trends
3. Any concerns or recommendations

Respond with JSON:
{
  "status": "normal" | "anomaly" | "critical",
  "summary": "3-5 sentences in Polish — daily summary for the team",
  "anomalies": [{ "metric": "...", "expected": "...", "actual": "...", "severity": "low|medium|high" }],
  "recommendations": ["actionable recommendation in Polish"]
}`;

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];
}

/** Build the full prompt text for persistence (so dashboard can show what AI saw). */
export function promptToText(messages: Array<{ role: string; content: string }>): string {
  return messages.map(m => `[${m.role}]\n${m.content}`).join('\n\n');
}
