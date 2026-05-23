import type { OrgContext, IntegrationInstance } from '../../lib/org-context.js';
import { createHandler } from './handler.js';
import { createRouter } from './routes.js';

export function createIntegration(ctx: OrgContext): IntegrationInstance {
  const handler = createHandler(ctx);
  const router = createRouter(handler);

  return {
    router,
    handlers: {
      processManual: (dealRecordId: string, listId: string) => handler.processLeadManual(dealRecordId, listId),
      enrichLeadData: handler.enrichLeadData,
      listChannelMap: handler.listChannelMap,
    },
  };
}
