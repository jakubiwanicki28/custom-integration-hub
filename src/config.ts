import 'dotenv/config';
import { createHmac } from 'crypto';
import type { OrgCredentials } from './lib/org-context.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// Shared config — not per-org
export const config = {
  port: Number(process.env.PORT) || 3100,
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: (process.env.NODE_ENV || 'development') === 'development',

  openrouter: {
    apiKey: requireEnv('OPENROUTER_API_KEY'),
    baseUrl: 'https://openrouter.ai/api/v1',
    model: process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash-lite',
  },

  dashboard: {
    password: process.env.DASHBOARD_PASSWORD || '',
    cookieSecret: process.env.DASHBOARD_SECRET
      || (process.env.DASHBOARD_PASSWORD
        ? createHmac('sha256', 'dashboard-cookie-key').update(process.env.DASHBOARD_PASSWORD).digest('hex')
        : ''),
  },
} as const;

// Per-org credentials — loaded on demand via env prefix
export function loadOrgCredentials(envPrefix: string, requiredServices: string[]): OrgCredentials {
  const needsAttio = requiredServices.includes('attio');
  const needsSlack = requiredServices.includes('slack');
  const needsCloudtalk = requiredServices.includes('cloudtalk');

  return {
    attio: {
      apiKey: needsAttio ? requireEnv(`${envPrefix}_ATTIO_API_KEY`) : (process.env[`${envPrefix}_ATTIO_API_KEY`] || ''),
      webhookSecret: process.env[`${envPrefix}_ATTIO_WEBHOOK_SECRET`] || '',
    },
    slack: {
      botToken: needsSlack ? (process.env[`${envPrefix}_SLACK_BOT_TOKEN`] || '') : '',
    },
    cloudtalk: needsCloudtalk ? {
      apiId: requireEnv(`${envPrefix}_CLOUDTALK_API_ID`),
      apiKey: requireEnv(`${envPrefix}_CLOUDTALK_API_KEY`),
    } : undefined,
  };
}
