import type { MetricsSnapshot } from '../metrics.js';
import type { VercelProjectHealth } from './types.js';

// Known bot/scanner paths — tagged in prompt so AI knows to ignore them
const KNOWN_BOT_PATHS = [
  '/wp-admin', '/wp-login.php', '/xmlrpc.php', '/wp-content', '/wp-includes',
  '/.env', '/.git', '/config', '/admin', '/phpmyadmin', '/pma',
  '/favicon.ico', '/robots.txt', '/sitemap.xml',
];

function isBotPath(path: string): boolean {
  return KNOWN_BOT_PATHS.some(bp => path.startsWith(bp) || path === bp);
}

function formatSnapshot(snapshot: MetricsSnapshot, label: string): string {
  const lines: string[] = [`=== ${label} ===`];
  const { totals, byIntegration, http } = snapshot;

  lines.push(`Integration events: ${totals.total} total (${totals.success} ok, ${totals.error} err, ${totals.skip} skip, ${totals.dedup} dedup)`);
  lines.push(`HTTP requests: ${http.total} total, ${http.errors} errors, avg ${http.avgDurationMs}ms`);

  if (Object.keys(http.byStatus).length > 0) {
    const statusParts = Object.entries(http.byStatus).map(([s, c]) => `${s}:${c}`).join(', ');
    lines.push(`HTTP by status: ${statusParts}`);
  }

  // Top HTTP paths with bot detection
  if (http.topPaths && http.topPaths.length > 0) {
    lines.push('');
    lines.push('TOP HTTP PATHS:');
    for (const p of http.topPaths) {
      const statusDetail = Object.entries(p.statuses).map(([s, c]) => `${c}×${s}`).join(', ');
      const botTag = isBotPath(p.path) ? '  ← bot/scanner' : '';
      lines.push(`  ${p.path}: ${p.count} reqs (${statusDetail})${botTag}`);
    }
  }

  for (const [name, stats] of Object.entries(byIntegration)) {
    const orgParts = Object.entries(stats.byOrg).map(([o, c]) => `${o}:${c}`).join(', ');
    lines.push(`  ${name}: ${stats.total} total (${stats.success} ok, ${stats.error} err, ${stats.skip} skip) avg ${stats.avgDurationMs}ms max ${stats.maxDurationMs}ms [${orgParts}]`);
  }

  // Error/skip reasons
  if (snapshot.errorReasons && Object.keys(snapshot.errorReasons).length > 0) {
    lines.push('');
    lines.push('ERROR/SKIP REASONS:');
    for (const [reason, count] of Object.entries(snapshot.errorReasons).sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${reason}: ${count}`);
    }
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

const SYSTEM_PROMPT = `You are a monitoring analyst for Custom Integration Hub — a business automation server on a single VPS handling CRM syncs, lead intake, call transcription, deploy notifications, and Slack alerts for multiple organizations.

ORGANIZATIONS:
- ww-partners: consulting firm (Akademia Biznesu, Raport Strategiczny campaigns). Integrations: lead-intake, calendly-booking-sync, cloudtalk-call-notes, slack-lead-notifications
- velocy: software house. Integrations: lead-intake, slack-lead-notifications
- bookclinic: SaaS medical clinic app. Integrations: vercel-deploy-notifications, github-pr-automation

KNOWN NOISE (do NOT alert, action_required: false):
- 404 on paths marked "bot/scanner" (e.g. /wp-admin, /.env, /xmlrpc.php) = internet bots probing. Normal internet noise, ignore completely.
- 429 responses = rate limiter WORKING CORRECTLY. This is the server defending itself. Only concerning if blocking legitimate endpoints like /{org}/lead-intake with real user traffic behind it.
- Low/zero activity outside business hours (20:00-08:00 CET) and weekends = normal.
- "person_not_found" and "short_call" skip reasons = normal business logic (not our leads, calls too short).
- Dedup events = idempotency working correctly. Healthy sign.

REAL PROBLEMS (action_required: true):
- HTTP 5xx on any path = server error, investigate immediately
- Integration errors with reason "unhandled_error" = code bug
- Integration errors with reason "slack_post_failed" or "enrich_failed" = external service down
- Zero lead-intake events during business hours (10-18 CET weekdays) when baseline shows normal activity = LP or CRM may be down
- Vercel project in ERROR state = build broken, deploy failed
- Sustained error rate > 30% on a single integration = systemic issue

RESPONSE FORMAT: JSON only, respond in Polish. Set action_required: true ONLY when human intervention is needed.`;

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
    userContent += '\n\nBASELINE: Not available yet (cold start, < 7 days of data). Be conservative — default to normal unless actual server errors.';
  }

  const vercelSection = formatVercelHealth(vercelHealth);
  if (vercelSection) userContent += '\n\n' + vercelSection;

  userContent += `\n\nRespond with JSON:
{
  "status": "normal" | "anomaly" | "critical",
  "action_required": true | false,
  "summary": "Po polsku: (1) Co się dzieje, (2) Czy wymaga akcji, (3) Jeśli tak — co zrobić. Jeśli to szum — napisz że nie wymaga uwagi.",
  "anomalies": [{ "metric": "czytelny opis po polsku", "expected": "czytelna wartość", "actual": "czytelna wartość", "severity": "low|medium|high" }]
}

RULES:
- action_required = true ONLY when human must act. Bots blocked, rate limiting, low night traffic = false.
- "metric" must be human-readable Polish, e.g. "Błędy HTTP 404 na hubie" NOT "http_status_404"
- If cold start (no baseline): default to "normal" + action_required: false unless 5xx or integration failures
- If everything is fine: status "normal", action_required: false, empty anomalies`;

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

  for (const { snapshot } of hourlySnapshots) {
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
3. Whether any action is needed

Respond with JSON:
{
  "status": "normal" | "anomaly" | "critical",
  "action_required": true | false,
  "summary": "3-5 sentences in Polish — daily summary. Mention if bots were active (and that it's normal noise).",
  "anomalies": [{ "metric": "czytelny opis", "expected": "wartość", "actual": "wartość", "severity": "low|medium|high" }],
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
