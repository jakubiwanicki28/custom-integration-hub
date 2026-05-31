import { Router } from 'express';
import type { Request, Response } from 'express';
import { createRateLimiter } from '../../lib/rate-limit.js';

export function createRouter(
  handler: {
    webhookHandler: (req: Request, res: Response) => Promise<void>;
    notifyHandler: (req: Request, res: Response) => Promise<void>;
  },
  allowedOrigins: string[],
): Router {
  const router = Router();
  const rateLimiter = createRateLimiter({ maxRequests: 10, windowMs: 60_000 });

  // CORS for /notify (called from LP frontend)
  router.use('/notify', (req: Request, res: Response, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    next();
  });

  router.post('/webhook', rateLimiter, handler.webhookHandler);
  router.post('/notify', rateLimiter, handler.notifyHandler);
  return router;
}
