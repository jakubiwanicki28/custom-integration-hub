import express from 'express';
import { config, loadOrgCredentials } from './config.js';
import { logger } from './lib/logger.js';
import {
  loadIntegrationCatalog, loadOrganizations, getAllOrganizations,
  getCatalogEntry, importIntegrationModule, registerMountedIntegration,
  getAllMountedIntegrations,
} from './lib/registry.js';
import { createAttioClient } from './lib/attio.js';
import { createSlackClient } from './lib/slack.js';
import { createCloudTalkClient } from './lib/cloudtalk.js';
import { dashboardRouter } from './dashboard.js';
import type { OrgContext } from './lib/org-context.js';

const app = express();
app.set('trust proxy', 1);

app.use(express.json({
  limit: '2mb',
  verify: (_req, _res, buf) => {
    (_req as express.Request & { rawBody?: Buffer }).rawBody = buf;
  },
}));
app.use(express.urlencoded({ extended: true }));

app.use((req, _res, next) => {
  logger.info({ method: req.method, path: req.path }, 'request');
  next();
});

// Health endpoint — shows all orgs and their integrations
app.get('/health', (_req, res) => {
  const mounted = getAllMountedIntegrations();
  const orgs = getAllOrganizations();

  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    organizations: orgs.map(org => ({
      id: org.id,
      name: org.name,
      integrations: mounted
        .filter(m => m.orgId === org.id)
        .map(m => ({
          id: m.integrationId,
          name: m.catalogEntry.name,
          status: m.status,
          type: m.catalogEntry.type,
          path: `/${org.id}${getIntegrationPath(m.integrationId)}`,
        })),
    })),
  });
});

function getIntegrationPath(integrationId: string): string {
  return `/${integrationId}`;
}

async function bootstrap() {
  // Load both config files
  const catalog = loadIntegrationCatalog();
  const organizations = loadOrganizations();

  // Dashboard
  app.use('/dashboard', dashboardRouter);
  if (config.dashboard.password) {
    app.get('/', (_req, res) => res.redirect('/dashboard'));
  }

  let totalMounted = 0;

  for (const org of organizations) {
    const orgLog = logger.child({ org: org.id });

    // Determine which services this org needs (union of all active integrations' requirements)
    const mountableIntegrations = org.integrations.filter(i => i.status === 'active' || i.status === 'development');
    const requiredServices = new Set<string>();
    for (const orgInt of mountableIntegrations) {
      const catalogEntry = getCatalogEntry(orgInt.integrationId);
      if (catalogEntry) {
        for (const svc of catalogEntry.requiredServices) requiredServices.add(svc);
      }
    }

    // Load org credentials
    let credentials;
    try {
      credentials = loadOrgCredentials(org.envPrefix, Array.from(requiredServices));
    } catch (err) {
      orgLog.error({ err }, 'Failed to load org credentials — skipping org');
      continue;
    }

    // Create API clients for this org
    const attioClient = createAttioClient(credentials.attio.apiKey, orgLog.child({ lib: 'attio' }));
    const slackClient = credentials.slack.botToken
      ? createSlackClient(credentials.slack.botToken, orgLog.child({ lib: 'slack' }))
      : undefined;
    const cloudtalkClient = credentials.cloudtalk
      ? createCloudTalkClient(credentials.cloudtalk.apiId, credentials.cloudtalk.apiKey, orgLog.child({ lib: 'cloudtalk' }))
      : undefined;

    // Mount each active integration for this org
    for (const orgInt of mountableIntegrations) {
      const catalogEntry = getCatalogEntry(orgInt.integrationId);
      if (!catalogEntry) {
        orgLog.warn({ integrationId: orgInt.integrationId }, 'Integration not found in catalog');
        continue;
      }

      // Check required services are available
      const missingServices = catalogEntry.requiredServices.filter(svc => {
        if (svc === 'attio') return !credentials.attio.apiKey;
        if (svc === 'slack') return !slackClient;
        if (svc === 'cloudtalk') return !cloudtalkClient;
        if (svc === 'openrouter') return false; // shared, always available
        return false;
      });

      if (missingServices.length > 0) {
        orgLog.warn({ integrationId: orgInt.integrationId, missingServices }, 'Missing required services — skipping');
        continue;
      }

      const ctx: OrgContext = {
        org: {
          id: org.id,
          name: org.name,
          attioWorkspaceSlug: org.attioWorkspaceSlug,
          webhookSecret: credentials.attio.webhookSecret,
        },
        clients: {
          attio: attioClient,
          slack: slackClient,
          cloudtalk: cloudtalkClient,
        },
        integrationConfig: orgInt.config ?? {},
        log: orgLog,
      };

      try {
        const mod = await importIntegrationModule(catalogEntry);
        const instance = mod.createIntegration(ctx);

        const mountPath = `/${org.id}/${catalogEntry.id}`;
        app.use(mountPath, instance.router);
        registerMountedIntegration(org.id, catalogEntry.id, instance, catalogEntry, ctx, orgInt.status);

        orgLog.info({ integrationId: catalogEntry.id, path: mountPath }, 'Integration mounted');
        totalMounted++;

        // Start poller if integration has one
        if (instance.startPoller && (catalogEntry.type === 'hybrid' || catalogEntry.type === 'cron')) {
          instance.startPoller();
          orgLog.info({ integrationId: catalogEntry.id }, 'Poller started');
        }
      } catch (err) {
        orgLog.error({ integrationId: catalogEntry.id, err }, 'Failed to mount integration');
      }
    }
  }

  if (totalMounted === 0) {
    logger.warn('No active integrations mounted for any organization');
  } else {
    logger.info({ totalMounted }, 'All integrations mounted');
  }

  // Global error handler
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err: err.message, stack: err.stack }, 'Unhandled error');
    res.status(500).json({ error: 'Internal server error' });
  });

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.nodeEnv, totalMounted }, 'Custom Integration Hub started');
  });

  let shuttingDown = false;
  function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutdown signal received, closing gracefully');
    server.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });
    setTimeout(() => {
      logger.error('Forced shutdown after 30s timeout');
      process.exit(1);
    }, 30_000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled promise rejection');
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception — shutting down');
  process.exit(1);
});

bootstrap().catch(err => {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
});
