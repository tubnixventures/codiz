import { Hono } from 'hono';
import { getEnv } from '../config/env.ts';
import { AFRICAN_CURRENCY_RATES } from '../config/models.ts';
import { getDb } from '../db/sqlite.ts';
import { artifactStorage } from '../providers/storage/gcs.ts';
import { getBudgetSnapshot } from '../services/budget/tracker.ts';

export const usageRouter = new Hono();

usageRouter.get('/budget', async (c) => {
  const env = getEnv();
  const snapshot = getBudgetSnapshot();
  const storage = await artifactStorage.getStatus();
  const db = getDb();

  const recentLedger = db
    .prepare(
      `SELECT id, category, provider, tokens_in, tokens_out, estimated_cost_usd, local_saved_usd, created_at
       FROM usage_ledger ORDER BY created_at DESC LIMIT 20`
    )
    .all();

  return c.json({
    budget: snapshot,
    preferredCurrency: env.PREFERRED_CURRENCY,
    currencies: AFRICAN_CURRENCY_RATES,
    storage,
    recentLedger,
  });
});
