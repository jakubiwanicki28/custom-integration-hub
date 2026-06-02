import { Router } from 'express';
import type { Request, Response } from 'express';

export function createRouter(
  handler: { slashCommandHandler: (req: Request, res: Response) => Promise<void> },
): Router {
  const router = Router();
  router.post('/slash-command', handler.slashCommandHandler);
  return router;
}
