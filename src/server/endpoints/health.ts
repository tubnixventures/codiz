import { Hono } from 'hono';
import { getDb } from '../db/sqlite.ts';
import { probeInferenceBackends } from '../providers/llm/router.ts';
import { artifactStorage } from '../providers/storage/gcs.ts';

export const healthRouter = new Hono();

healthRouter.get('/health', async (c) => {
  const db = getDb();
  const dbOk = Boolean(db.prepare('SELECT 1 as ok').get());
  const backends = await probeInferenceBackends();
  const storage = await artifactStorage.getStatus();

  return c.json({
    status: dbOk ? 'ok' : 'degraded',
    service: 'codiz-hono-gateway',
    timestamp: new Date().toISOString(),
    database: dbOk ? 'connected' : 'error',
    inference: backends,
    storage: {
      backend: storage.backend,
      bucketName: storage.bucketName,
    },
  });
});

healthRouter.get('/ready', (c) => {
  const db = getDb();
  db.prepare('SELECT 1').get();
  return c.json({ ready: true });
});

healthRouter.get('/live', (c) => {
  return c.json({ live: true, uptimeSec: Math.round(process.uptime()) });
});
