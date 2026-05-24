import { Router } from 'express';
import type { Request, Response } from 'express';
import type { LeadIntakeResponse } from './types.js';

// --- Rate limiter (IP-based) ---

const rateLimits = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 10; // requests per window
const RATE_WINDOW = 60_000; // 1 minute

const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimits) {
    if (now > entry.resetAt) rateLimits.delete(ip);
  }
}, 5 * 60_000);
cleanup.unref();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimits.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimits.set(ip, { count: 1, resetAt: now + RATE_WINDOW });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT;
}

export function createRouter(
  handler: {
    validateRequest: (body: unknown) => { data: import('./types.js').LeadIntakeRequest; error?: undefined } | { data?: undefined; error: string };
    processLead: (data: import('./types.js').LeadIntakeRequest) => Promise<LeadIntakeResponse>;
  },
  allowedOrigins: string[],
): Router {
  const router = Router();

  // CORS middleware (only for this router)
  router.use((req: Request, res: Response, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '86400');
    }

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  });

  router.post('/', async (req: Request, res: Response) => {
    const ip = req.ip || 'unknown';
    if (isRateLimited(ip)) {
      res.status(429).json({ ok: false, error: 'Too many requests' });
      return;
    }

    const validation = handler.validateRequest(req.body);
    if ('error' in validation) {
      res.status(400).json({ ok: false, error: validation.error });
      return;
    }

    try {
      const result = await handler.processLead(validation.data);
      res.status(result.ok ? 200 : 500).json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  });

  return router;
}
