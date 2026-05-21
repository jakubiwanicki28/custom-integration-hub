import express from 'express';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { loadRegistry, getActiveIntegrations, getAllIntegrations, importIntegration } from './lib/registry.js';

const app = express();

app.use(express.json({ limit: '2mb' }));
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

  // Global error handler
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err: err.message, stack: err.stack }, 'Unhandled error');
    res.status(500).json({ error: 'Internal server error' });
  });

  app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.nodeEnv, activeIntegrations: active.length }, 'Custom Integration Hub started');
  });
}

bootstrap().catch(err => {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
});
