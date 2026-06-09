import { Router } from 'express';
import type { Request, Response } from 'express';

export function createRouter(handler: {
  webhookHandler: (req: Request, res: Response) => Promise<void>;
}): Router {
  const router = Router();
  router.post('/webhook', handler.webhookHandler);
  return router;
}
