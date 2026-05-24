import type { OrgContext, IntegrationInstance } from '../../lib/org-context.js';
import { createHandler } from './handler.js';
import { createRouter } from './routes.js';

export function createIntegration(ctx: OrgContext): IntegrationInstance {
  const handler = createHandler(ctx);
  const allowedOrigins = (ctx.integrationConfig.allowedOrigins ?? []) as string[];
  const log = ctx.log.child({ integration: 'lead-intake' });
  const router = createRouter(handler, allowedOrigins, log);

  return {
    router,
    handlers: {},
  };
}
