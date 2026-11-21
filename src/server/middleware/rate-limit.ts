import type { Context, Next } from 'hono';

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export function rateLimit(options: { windowMs: number; maxRequests: number }) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const key = `${c.req.header('x-forwarded-for') ?? 'local'}:${c.req.path}`;
    const now = Date.now();
    const existing = buckets.get(key);

    if (!existing || now > existing.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      await next();
      return;
    }

    if (existing.count >= options.maxRequests) {
      c.header('Retry-After', String(Math.ceil((existing.resetAt - now) / 1000)));
      return c.json(
        {
          error: 'Rate limit exceeded. Throttling requests to protect local CPU and $20/mo budget.',
        },
        429
      );
    }

    existing.count += 1;
    await next();
  };
}
