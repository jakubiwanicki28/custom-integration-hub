import { Router } from 'express';
import type { Request, Response } from 'express';
import { createRateLimiter } from '../../lib/rate-limit.js';

export function createRouter(handler: { webhookHandler: (req: Request, res: Response) => Promise<void> }): Router {
  const router = Router();
  router.post('/webhook', createRateLimiter({ maxRequests: 20, windowMs: 60_000 }), handler.webhookHandler);
  return router;
}
