import type { OrgContext, IntegrationInstance } from '../../lib/org-context.js';
import { createHandler } from './handler.js';
import { createRouter } from './routes.js';

export function createIntegration(ctx: OrgContext): IntegrationInstance {
  if (!ctx.clients.notion) throw new Error('fathom-meeting-notes requires Notion client');

  const handler = createHandler(ctx);
  const router = createRouter(handler);

  return {
    router,
    handlers: {
      processManual: (recordingId: string) => handler.processMeetingManual(recordingId),
      registerWebhook: () => handler.registerFathomWebhook(),
      createNotionDatabase: () => handler.createNotionDatabase(),
    },
  };
}
