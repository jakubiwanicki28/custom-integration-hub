import type { Logger } from 'pino';
import { metrics } from '../metrics.js';
import type { VercelProjectHealth, MonitoringConfig } from './types.js';

interface VercelClient {
  getRecentDeployments(projectId: string, limit?: number): Promise<Array<{
    uid: string;
    state: string;
    created: number;
    buildingAt?: number;
    meta: Record<string, string>;
  }>>;
}

interface MonitoredProject {
  id: string;
  name: string;
  label: string;
  org: string;
}

const STUCK_BUILD_THRESHOLD_MS = 10 * 60 * 1000; // 10 min

export function createVercelMonitor(
  vercel: VercelClient,
  projectConfig: MonitoringConfig['vercel']['projects'],
  log: Logger,
) {
  // Flatten project config into a single list with org tags
  const monitoredProjects: MonitoredProject[] = [];
  for (const [org, projects] of Object.entries(projectConfig)) {
    for (const p of projects) {
      monitoredProjects.push({ ...p, org });
    }
  }

  if (monitoredProjects.length === 0) {
    log.info('No Vercel projects to monitor');
    return { checkHealth: async () => [], startPolling: () => () => {} };
  }

  let previousStates = new Map<string, string>();

  async function checkHealth(): Promise<VercelProjectHealth[]> {
    const results: VercelProjectHealth[] = [];

    for (const project of monitoredProjects) {
      try {
        const deployments = await vercel.getRecentDeployments(project.id, 1);
        const latest = deployments[0];

        if (!latest) {
          results.push({
            projectId: project.id,
            projectName: project.name,
            label: project.label,
            org: project.org,
            state: 'UNKNOWN',
            lastDeployAt: null,
          });
          continue;
        }

        let state = latest.state as VercelProjectHealth['state'];

        // Detect stuck builds
        if (state === 'BUILDING' && latest.buildingAt) {
          const buildingMs = Date.now() - latest.buildingAt;
          if (buildingMs > STUCK_BUILD_THRESHOLD_MS) {
            state = 'ERROR'; // Treat stuck build as error
          }
        }

        const health: VercelProjectHealth = {
          projectId: project.id,
          projectName: project.name,
          label: project.label,
          org: project.org,
          state,
          lastDeployAt: latest.created,
          branch: latest.meta?.githubCommitRef,
          commitMessage: (latest.meta?.githubCommitMessage || '').split('\n')[0],
        };

        results.push(health);

        // Track state transitions
        const prevState = previousStates.get(project.id);
        if (prevState && prevState !== state) {
          const isRecovery = prevState === 'ERROR' && state === 'READY';
          const isFailure = state === 'ERROR';

          metrics.track({
            integration: '_vercel',
            org: project.org,
            event: isFailure ? 'error' : isRecovery ? 'success' : 'success',
            meta: {
              project: project.name,
              prevState: prevState,
              newState: state,
              transition: isRecovery ? 'recovery' : isFailure ? 'failure' : 'change',
            },
          });
        }

        previousStates.set(project.id, state);
      } catch (err) {
        log.error({ err, project: project.name }, 'Failed to check Vercel project health');
        results.push({
          projectId: project.id,
          projectName: project.name,
          label: project.label,
          org: project.org,
          state: 'UNKNOWN',
          lastDeployAt: null,
        });
      }
    }

    return results;
  }

  function startPolling(intervalMs: number, onHealth: (health: VercelProjectHealth[]) => void): () => void {
    // Initial check after 30s (let server start first)
    const initialDelay = setTimeout(async () => {
      const health = await checkHealth();
      onHealth(health);
    }, 30_000);
    initialDelay.unref();

    const interval = setInterval(async () => {
      try {
        const health = await checkHealth();
        onHealth(health);
      } catch (err) {
        log.error({ err }, 'Vercel health poll failed');
      }
    }, intervalMs);
    interval.unref();

    log.info({ projects: monitoredProjects.length, intervalMs }, 'Vercel monitor started');

    return () => {
      clearTimeout(initialDelay);
      clearInterval(interval);
    };
  }

  return { checkHealth, startPolling, monitoredProjects };
}
