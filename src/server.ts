import express from 'express';
import { resolve } from 'path';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { loadRegistry, getActiveIntegrations, getAllIntegrations, importIntegration } from './lib/registry.js';
import { dashboardRouter } from './dashboard.js';

const app = express();
app.set('trust proxy', 1); // Trust only the first proxy (nginx)

app.use(express.json({
  limit: '2mb',
  verify: (_req, _res, buf) => {
    // Store raw body for webhook signature verification
    (_req as express.Request & { rawBody?: Buffer }).rawBody = buf;
  },
}));
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, _res, next) => {
  logger.info({ method: req.method, path: req.path }, 'request');
  next();
});

// Health endpoint — shows active integrations
app.get('/health', (_req, res) => {
  const all = getAllIntegrations();
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    integrations: all.map(i => ({
      id: i.id,
      name: i.name,
      status: i.status,
      type: i.type,
      path: i.path,
    })),
  });
});

// Load registry and mount active integrations
async function bootstrap() {
  loadRegistry();

  // Dashboard (must be mounted after registry is loaded)
  app.use('/dashboard', dashboardRouter);
  if (config.dashboard.password) {
    app.get('/', (_req, res) => res.redirect('/dashboard'));
  }

  const active = getActiveIntegrations();

  for (const entry of active) {
    try {
      const mod = await importIntegration(entry);
      app.use(entry.path, mod.router);
      logger.info({ id: entry.id, path: entry.path }, 'Integration mounted');
    } catch (err) {
      logger.error({ id: entry.id, err }, 'Failed to load integration');
    }
  }

  if (active.length === 0) {
    logger.warn('No active integrations found in registry');
  }

  // Start pollers for hybrid/cron integrations (dynamic import — no static coupling)
  for (const entry of active) {
    if (entry.type === 'hybrid' || entry.type === 'cron') {
      try {
        const modulePath = resolve(process.cwd(), entry.module);
        const mod = await import(modulePath);
        if (typeof mod.startPoller === 'function') {
          mod.startPoller();
          logger.info({ id: entry.id }, 'Poller started');
        }
      } catch (err) {
        logger.error({ err, id: entry.id }, 'Failed to start poller');
      }
    }
  }

  // Global error handler
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err: err.message, stack: err.stack }, 'Unhandled error');
    res.status(500).json({ error: 'Internal server error' });
  });

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.nodeEnv, activeIntegrations: active.length }, 'Custom Integration Hub started');
  });

  // Graceful shutdown — shared by SIGTERM and SIGINT
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

// Global safety nets — must be registered before bootstrap
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
