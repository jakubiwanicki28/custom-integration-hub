import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Logger } from 'pino';
import type { LeadIntakeResponse } from './types.js';
import { createRateLimiter } from '../../lib/rate-limit.js';

export function createRouter(
  handler: {
    validateRequest: (body: unknown) => { data: import('./types.js').LeadIntakeRequest; error?: undefined } | { data?: undefined; error: string };
    processLead: (data: import('./types.js').LeadIntakeRequest) => Promise<LeadIntakeResponse>;
  },
  allowedOrigins: string[],
  log: Logger,
): Router {
  const router = Router();

  // CORS middleware (only for this router)
  router.use((req: Request, res: Response, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '86400');
    }

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  });

  router.post('/', createRateLimiter({ maxRequests: 10, windowMs: 60_000 }), async (req: Request, res: Response) => {
    const validation = handler.validateRequest(req.body);
    if ('error' in validation) {
      res.status(400).json({ ok: false, error: validation.error });
      return;
    }

    try {
      const result = await handler.processLead(validation.data);
      res.status(result.ok ? 200 : 500).json(result);
    } catch (err) {
      log.error({ err }, 'Lead intake request error');
      res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  });

  return router;
}
