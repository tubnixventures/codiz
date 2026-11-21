import type { Context, Next } from 'hono';

export async function structuredLogger(c: Context, next: Next): Promise<void> {
  const start = Date.now();
  const requestId = c.req.header('x-request-id') ?? crypto.randomUUID().slice(0, 8);
  c.header('x-request-id', requestId);

  await next();

  const durationMs = Date.now() - start;
  if (process.env.NODE_ENV !== 'test') {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        requestId,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs,
      })
    );
  }
}
