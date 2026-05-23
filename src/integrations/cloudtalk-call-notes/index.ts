import type { OrgContext, IntegrationInstance } from '../../lib/org-context.js';
import { createHandler } from './handler.js';
import { createTranscriber } from './transcribe.js';
import { createPoller } from './poller.js';
import { createRouter } from './routes.js';

export function createIntegration(ctx: OrgContext): IntegrationInstance {
  const log = ctx.log.child({ integration: 'cloudtalk-call-notes' });
  const cloudtalk = ctx.clients.cloudtalk!;

  const transcribeCall = createTranscriber(cloudtalk, log);
  const handler = createHandler(ctx, transcribeCall);
  const router = createRouter(handler);
  const startPoller = createPoller(cloudtalk, handler, log);

  return {
    router,
    handlers: {
      processManual: (callId: string) => handler.processCallManual(callId),
    },
    startPoller,
  };
}
