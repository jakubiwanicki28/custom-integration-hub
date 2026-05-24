import { Router } from 'express';
import type { Request, Response } from 'express';
import type { ProcessLeadResult } from './types.js';

export function createRouter(handler: {
  webhookHandler: (req: Request, res: Response) => Promise<void>;
  processLeadManual: (dealRecordId: string, listId: string) => Promise<ProcessLeadResult>;
}): Router {
  const router = Router();
  router.post('/webhook', handler.webhookHandler);

  // Temporary diagnostic endpoint — remove after debugging
  router.get('/debug-test', async (req: Request, res: Response) => {
    const { deal, list } = req.query;
    if (!deal || !list) {
      res.json({ error: 'Usage: ?deal=RECORD_ID&list=LIST_ID' });
      return;
    }
    const result = await handler.processLeadManual(String(deal), String(list));
    res.json(result);
  });

  return router;
}
