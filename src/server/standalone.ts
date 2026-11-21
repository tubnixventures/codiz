import 'dotenv/config';
import { serve } from '@hono/node-server';
import { getEnv } from './config/env.ts';
import { getDb } from './db/sqlite.ts';
import { createCodizApiApp } from './app.ts';

const env = getEnv();
getDb();
const app = createCodizApiApp();

serve(
  {
    fetch: app.fetch,
    port: env.PORT,
    hostname: '0.0.0.0',
  },
  (info) => {
    console.log(`Codiz Hono Gateway listening standalone on http://0.0.0.0:${info.port}`);
  }
);
