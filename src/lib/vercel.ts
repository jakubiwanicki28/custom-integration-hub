import type { Logger } from 'pino';
import { fetchWithTimeout, safeJson } from './fetch.js';

// --- Types ---

export interface VercelDeployment {
  uid: string;
  state: 'BUILDING' | 'READY' | 'ERROR' | 'CANCELED' | 'QUEUED';
  url: string;
  created: number;
  buildingAt?: number;
  ready?: number;
  source?: string;
  meta: Record<string, string>;
}

// --- Factory ---

export function createVercelClient(apiToken: string, teamId: string, log: Logger) {
  const headers = {
    Authorization: `Bearer ${apiToken}`,
  };

  function teamParam(url: URL): void {
    if (teamId) url.searchParams.set('teamId', teamId);
  }

  async function getRecentDeployments(projectId: string, limit = 1): Promise<VercelDeployment[]> {
    const url = new URL('https://api.vercel.com/v6/deployments');
    url.searchParams.set('projectId', projectId);
    url.searchParams.set('limit', String(limit));
    teamParam(url);

    try {
      const res = await fetchWithTimeout(url.toString(), { method: 'GET', headers });

      if (!res.ok) {
        log.error({ status: res.status, projectId }, 'Vercel deployments API error');
        return [];
      }

      const data = await safeJson<{ deployments: VercelDeployment[] }>(res);
      return data.deployments ?? [];
    } catch (err) {
      log.error({ err, projectId }, 'Vercel getRecentDeployments failed');
      return [];
    }
  }

  return { getRecentDeployments };
}
