import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { getEnv } from './src/server/config/env.ts';
import { getDb } from './src/server/db/sqlite.ts';
import { createCodizApiApp } from './src/server/app.ts';

async function startServer() {
  const env = getEnv();
  getDb();

  const expressApp = express();
  const honoApi = createCodizApiApp();

  // Bridge all /api/* requests directly into the Hono TypeScript API Gateway
  expressApp.use('/api', async (req, res, next) => {
    try {
      const protocol = req.protocol || 'http';
      const host = req.get('host') || `localhost:${env.PORT}`;
      const url = new URL(req.originalUrl, `${protocol}://${host}`);

      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers.set(k, v);
        else if (Array.isArray(v)) headers.set(k, v.join(', '));
      }

      let bodyBuffer: Buffer | undefined;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        if (chunks.length > 0) bodyBuffer = Buffer.concat(chunks);
      }

      const webRequest = new Request(url.toString(), {
        method: req.method,
        headers,
        body: bodyBuffer ? new Uint8Array(bodyBuffer) : undefined,
      });

      const webResponse = await honoApi.fetch(webRequest);
      res.status(webResponse.status);
      webResponse.headers.forEach((val, key) => {
        res.setHeader(key, val);
      });

      const arrayBuf = await webResponse.arrayBuffer();
      res.send(Buffer.from(arrayBuf));
    } catch (err) {
      next(err);
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    expressApp.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    if (fs.existsSync(distDir)) {
      expressApp.use(express.static(distDir));
      expressApp.get('*', (_req, res) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  }

  expressApp.listen(env.PORT, '0.0.0.0', () => {
    console.log(`Codiz Platform running on http://0.0.0.0:${env.PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start Codiz server:', err);
  process.exit(1);
});
