import 'dotenv/config';
import { createHmac } from 'crypto';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT) || 3100,
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: (process.env.NODE_ENV || 'development') === 'development',

  attio: {
    apiKey: requireEnv('ATTIO_API_KEY'),
    baseUrl: 'https://api.attio.com/v2',
  },

  cloudtalk: {
    apiId: requireEnv('CLOUDTALK_API_ID'),
    apiKey: requireEnv('CLOUDTALK_API_KEY'),
    baseUrl: 'https://my.cloudtalk.io/api',
    analyticsBaseUrl: 'https://analytics-api.cloudtalk.io/api',
  },

  openrouter: {
    apiKey: requireEnv('OPENROUTER_API_KEY'),
    baseUrl: 'https://openrouter.ai/api/v1',
  },

  webhook: {
    secret: process.env.WEBHOOK_SECRET || '',
  },

  dashboard: {
    password: process.env.DASHBOARD_PASSWORD || '',
    cookieSecret: process.env.DASHBOARD_PASSWORD
      ? createHmac('sha256', 'dashboard-cookie-key').update(process.env.DASHBOARD_PASSWORD).digest('hex')
      : '',
  },
} as const;
