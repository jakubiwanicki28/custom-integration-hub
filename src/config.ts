import 'dotenv/config';
import { randomBytes } from 'crypto';
import type { OrgCredentials } from './lib/org-context.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const isDev = (process.env.NODE_ENV || 'development') === 'development';

function resolveCookieSecret(): string {
  if (process.env.DASHBOARD_SECRET) return process.env.DASHBOARD_SECRET;
  if (isDev) {
    // In development, generate an ephemeral secret (sessions reset on restart — acceptable for dev)
    return randomBytes(32).toString('hex');
  }
  throw new Error('DASHBOARD_SECRET is required in production. Generate with: openssl rand -hex 32');
}

// Shared config — not per-org
export const config = {
  port: Number(process.env.PORT) || 3100,
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev,

  openrouter: {
    apiKey: requireEnv('OPENROUTER_API_KEY'),
    baseUrl: 'https://openrouter.ai/api/v1',
    model: process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash-lite',
  },

  webhookBaseUrl: process.env.WEBHOOK_BASE_URL || 'https://custom-integration-hub.velocy.co',

  dashboard: {
    password: process.env.DASHBOARD_PASSWORD || '',
    cookieSecret: resolveCookieSecret(),
  },
} as const;

// Per-org credentials — loaded on demand via env prefix
export function loadOrgCredentials(envPrefix: string, requiredServices: string[]): OrgCredentials {
  const needsAttio = requiredServices.includes('attio');
  const needsSlack = requiredServices.includes('slack');
  const needsCloudtalk = requiredServices.includes('cloudtalk');
  const needsGithub = requiredServices.includes('github');

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
    github: needsGithub ? {
      token: requireEnv(`${envPrefix}_GITHUB_TOKEN`),
    } : undefined,
    vercel: process.env[`${envPrefix}_VERCEL_WEBHOOK_SECRET`] ? {
      webhookSecret: process.env[`${envPrefix}_VERCEL_WEBHOOK_SECRET`]!,
    } : undefined,
  };
}
