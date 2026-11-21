import { getEnv } from '../../config/env.ts';
import { getDb } from '../../db/sqlite.ts';
import type { BudgetSnapshot } from '../../types/domain.ts';

function getMonthDayKeys(): { monthKey: string; dayKey: string } {
  const now = new Date();
  const monthKey = now.toISOString().slice(0, 7);
  const dayKey = now.toISOString().slice(0, 10);
  return { monthKey, dayKey };
}

export function recordUsage(params: {
  category: 'teacher-api' | 'cloud-run-gpu' | 'gcs-storage' | 'embeddings' | 'local-inference';
  provider: string;
  tokensIn: number;
  tokensOut: number;
  estimatedCostUsd: number;
  localSavedUsd?: number;
  metadata?: Record<string, unknown>;
}): void {
  const db = getDb();
  const { monthKey, dayKey } = getMonthDayKeys();
  db.prepare(
    `INSERT INTO usage_ledger (
      id, month_key, day_key, category, provider,
      tokens_in, tokens_out, estimated_cost_usd, local_saved_usd, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    `usg-${crypto.randomUUID().slice(0, 12)}`,
    monthKey,
    dayKey,
    params.category,
    params.provider,
    params.tokensIn,
    params.tokensOut,
    params.estimatedCostUsd,
    params.localSavedUsd ?? 0,
    JSON.stringify(params.metadata ?? {}),
    new Date().toISOString()
  );
}

export function getBudgetSnapshot(): BudgetSnapshot {
  const env = getEnv();
  const db = getDb();
  const { monthKey, dayKey } = getMonthDayKeys();

  const rows = db
    .prepare(
      `SELECT category, SUM(estimated_cost_usd) as spent, SUM(local_saved_usd) as saved
       FROM usage_ledger WHERE month_key = ? GROUP BY category`
    )
    .all(monthKey) as Array<{ category: string; spent: number; saved: number }>;

  let teacherApiUsd = 0;
  let cloudRunGpuUsd = 0;
  let gcsStorageUsd = 0;
  let embeddingsUsd = 0;
  let localSavingsUsd = 0;

  for (const r of rows) {
    if (r.category === 'teacher-api') teacherApiUsd += r.spent ?? 0;
    else if (r.category === 'cloud-run-gpu') cloudRunGpuUsd += r.spent ?? 0;
    else if (r.category === 'gcs-storage') gcsStorageUsd += r.spent ?? 0;
    else if (r.category === 'embeddings') embeddingsUsd += r.spent ?? 0;
    localSavingsUsd += r.saved ?? 0;
  }

  const totalSpentUsd = Number(
    (teacherApiUsd + cloudRunGpuUsd + gcsStorageUsd + embeddingsUsd).toFixed(4)
  );
  const percentUsed = Number(((totalSpentUsd / env.MONTHLY_BUDGET_USD) * 100).toFixed(2));

  let thresholdState: BudgetSnapshot['thresholdState'] = 'nominal';
  let advisoryNotice =
    'Nominal: local Q4_K_M inference incurs $0 compute charges; Cloud Run budget well within cap.';

  if (percentUsed >= 100) {
    thresholdState = 'paused_100';
    advisoryNotice =
      '100% Budget Cap Reached: Nonessential paid cloud workloads paused. Local Ollama/llama.cpp remains active at $0.';
  } else if (percentUsed >= 90) {
    thresholdState = 'restrict_90';
    advisoryNotice =
      '90% Threshold: Optional LoRA cloud training and batch teacher API calls automatically halted.';
  } else if (percentUsed >= 75) {
    thresholdState = 'warn_75';
    advisoryNotice =
      '75% Warning: Prioritize local inference and Muse Code JSONL imports over paid teacher requests.';
  } else if (percentUsed >= 50) {
    thresholdState = 'notify_50';
    advisoryNotice =
      '50% Notification: Half of monthly $20 cloud allowance used. Scale-to-zero active.';
  }

  const teacherCountRow = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM usage_ledger WHERE day_key = ? AND category = 'teacher-api'`
    )
    .get(dayKey) as { cnt: number };

  return {
    monthKey,
    monthlyBudgetUsd: env.MONTHLY_BUDGET_USD,
    totalSpentUsd,
    percentUsed,
    thresholdState,
    breakdown: {
      teacherApiUsd: Number(teacherApiUsd.toFixed(4)),
      cloudRunGpuUsd: Number(cloudRunGpuUsd.toFixed(4)),
      gcsStorageUsd: Number(gcsStorageUsd.toFixed(4)),
      embeddingsUsd: Number(embeddingsUsd.toFixed(4)),
    },
    localSavingsUsd: Number(localSavingsUsd.toFixed(4)),
    dailyTeacherCalls: teacherCountRow.cnt,
    maxDailyTeacherCalls: env.MAX_DAILY_TEACHER_CALLS,
    advisoryNotice,
  };
}

export function canExecutePaidWorkload(
  kind: 'teacher' | 'training-gpu',
  estimatedCostUsd: number
): { allowed: boolean; reason?: string } {
  const snap = getBudgetSnapshot();
  if (snap.thresholdState === 'paused_100') {
    return {
      allowed: false,
      reason: 'Monthly budget 100% cap reached. Switch to local Ollama/llama.cpp or increase cap.',
    };
  }
  if (snap.thresholdState === 'restrict_90') {
    return {
      allowed: false,
      reason: '90% budget threshold active: optional training and paid teacher requests are paused.',
    };
  }
  if (kind === 'teacher' && snap.dailyTeacherCalls >= snap.maxDailyTeacherCalls) {
    return {
      allowed: false,
      reason: `Daily teacher call limit (${snap.maxDailyTeacherCalls}) reached to protect budget.`,
    };
  }
  if (snap.totalSpentUsd + estimatedCostUsd > snap.monthlyBudgetUsd * 0.95) {
    return {
      allowed: false,
      reason: `Estimated job cost ($${estimatedCostUsd.toFixed(2)}) would breach the 95% monthly safety guard.`,
    };
  }
  return { allowed: true };
}
