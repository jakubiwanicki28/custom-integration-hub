import type { SlackBlock } from '../slack.js';
import { config } from '../../config.js';
import type { AnalysisResult, PersistedAnalysis, VercelProjectHealth } from './types.js';
import type { MetricsSnapshot } from '../metrics.js';

const dashboardUrl = () => `${config.webhookBaseUrl}/dashboard/monitoring`;

function statusEmoji(status: string): string {
  if (status === 'critical') return '🔴';
  if (status === 'anomaly') return '⚠️';
  return '🟢';
}

function severityEmoji(severity: string): string {
  if (severity === 'high') return '🔴';
  if (severity === 'medium') return '🟡';
  return '🔵';
}

export function formatAnomalyAlert(analysis: PersistedAnalysis): { blocks: SlackBlock[]; text: string } {
  const emoji = statusEmoji(analysis.status);
  const now = new Date();
  const timeStr = now.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Warsaw' });
  const dayStr = now.toLocaleDateString('pl-PL', { weekday: 'long', timeZone: 'Europe/Warsaw' });

  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${emoji} Hub Alert — ${dayStr} ${timeStr}`, emoji: true },
    },
  ];

  if (analysis.summary) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: analysis.summary },
    });
  }

  if (analysis.anomalies.length > 0) {
    blocks.push({ type: 'divider' });
    for (const a of analysis.anomalies) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${severityEmoji(a.severity)} *${a.metric}*\nAktualnie: ${a.actual} — Oczekiwano: ${a.expected}`,
        },
      });
    }
  }

  blocks.push({
    type: 'actions',
    elements: [{
      type: 'button',
      text: { type: 'plain_text', text: '📊 Szczegóły' },
      url: `${dashboardUrl()}?analysis=${encodeURIComponent(analysis.id)}`,
      action_id: 'view_monitoring',
    }],
  });

  return {
    blocks,
    text: `${emoji} Hub Alert: ${analysis.summary || analysis.status}`,
  };
}

export function formatDailyDigest(analysis: PersistedAnalysis, snapshot: MetricsSnapshot): { blocks: SlackBlock[]; text: string } {
  const now = new Date();
  const dateStr = now.toLocaleDateString('pl-PL', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Warsaw' });

  const successRate = snapshot.totals.total > 0
    ? Math.round((snapshot.totals.success / snapshot.totals.total) * 100)
    : 100;

  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `📊 Hub Daily Report — ${dateStr}`, emoji: true },
    },
  ];

  // Stats overview
  const statsLines: string[] = [];
  for (const [name, stats] of Object.entries(snapshot.byIntegration)) {
    const errPart = stats.error > 0 ? `, ${stats.error} err` : '';
    statsLines.push(`*${name}*: ${stats.total} events (${stats.success} ok${errPart})`);
  }

  if (statsLines.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: statsLines.join('\n') },
    });
  }

  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `📈 Requests: ${snapshot.http.total} | Success rate: ${successRate}% | HTTP errors: ${snapshot.http.errors}`,
    }],
  });

  if (analysis.summary) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `🤖 *AI:* ${analysis.summary}` },
    });
  }

  if (analysis.recommendations && analysis.recommendations.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '💡 *Rekomendacje:*\n' + analysis.recommendations.map(r => `• ${r}`).join('\n') },
    });
  }

  if (analysis.anomalies.length > 0) {
    blocks.push({ type: 'divider' });
    for (const a of analysis.anomalies) {
      blocks.push({
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `${severityEmoji(a.severity)} ${a.metric}: ${a.actual} (oczekiwano: ${a.expected})`,
        }],
      });
    }
  }

  blocks.push({
    type: 'actions',
    elements: [{
      type: 'button',
      text: { type: 'plain_text', text: '📊 Full Report' },
      url: dashboardUrl(),
      action_id: 'view_monitoring_daily',
    }],
  });

  return {
    blocks,
    text: `📊 Hub Daily Report — ${snapshot.totals.total} events, ${successRate}% success rate`,
  };
}
