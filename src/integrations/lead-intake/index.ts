import type { OrgContext, IntegrationInstance } from '../../lib/org-context.js';
import { createHandler } from './handler.js';
import { createRouter } from './routes.js';

export function createIntegration(ctx: OrgContext): IntegrationInstance {
  const handler = createHandler(ctx);
  const allowedOrigins = (ctx.integrationConfig.allowedOrigins ?? []) as string[];
  const router = createRouter(handler, allowedOrigins);

  return {
    router,
    handlers: {},
  };
}
