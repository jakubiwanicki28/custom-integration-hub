import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../logger.js';
import type { MonitoringConfig } from './types.js';

const log = logger.child({ lib: 'monitoring-config' });

const CONFIG_PATH = join(process.cwd(), 'monitoring.json');

const DEFAULT_CONFIG: MonitoringConfig = {
  vercel: {
    pollIntervalMs: 600_000,
    projects: {},
  },
  slack: {
    channelId: '',
    dailyDigestHour: 23,
    timezone: 'Europe/Warsaw',
  },
};

export function loadMonitoringConfig(): MonitoringConfig {
  try {
    if (!existsSync(CONFIG_PATH)) {
      log.info('monitoring.json not found, using defaults');
      return DEFAULT_CONFIG;
    }

    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));

    let pollIntervalMs = raw.vercel?.pollIntervalMs ?? DEFAULT_CONFIG.vercel.pollIntervalMs;
    if (typeof pollIntervalMs !== 'number' || pollIntervalMs < 10_000) {
      log.warn({ pollIntervalMs }, 'Invalid pollIntervalMs, using default 600s');
      pollIntervalMs = DEFAULT_CONFIG.vercel.pollIntervalMs;
    }

    let dailyDigestHour = raw.slack?.dailyDigestHour ?? DEFAULT_CONFIG.slack.dailyDigestHour;
    if (!Number.isInteger(dailyDigestHour) || dailyDigestHour < 0 || dailyDigestHour > 23) {
      log.warn({ dailyDigestHour }, 'Invalid dailyDigestHour (must be 0-23), using default');
      dailyDigestHour = DEFAULT_CONFIG.slack.dailyDigestHour;
    }

    return {
      vercel: {
        pollIntervalMs,
        projects: raw.vercel?.projects ?? {},
      },
      slack: {
        channelId: raw.slack?.channelId ?? '',
        dailyDigestHour,
        timezone: raw.slack?.timezone ?? DEFAULT_CONFIG.slack.timezone,
      },
    };
  } catch (err) {
    log.error({ err }, 'Failed to load monitoring.json, using defaults');
    return DEFAULT_CONFIG;
  }
}
