import type { Request, Response, NextFunction } from 'express';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export interface RateLimiterOptions {
  /** Max requests per window (default: 10) */
  maxRequests?: number;
  /** Window duration in ms (default: 60_000 = 1 min) */
  windowMs?: number;
}

export function createRateLimiter(options: RateLimiterOptions = {}) {
  const maxRequests = options.maxRequests ?? 10;
  const windowMs = options.windowMs ?? 60_000;

  const entries = new Map<string, RateLimitEntry>();

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of entries) {
      if (now > entry.resetAt) entries.delete(ip);
    }
  }, 5 * 60_000);
  cleanup.unref();

  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const entry = entries.get(ip);

    if (!entry || now > entry.resetAt) {
      entries.set(ip, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    entry.count++;
    if (entry.count > maxRequests) {
      res.status(429).json({ error: 'Too many requests' });
      return;
    }

    next();
  };
}
