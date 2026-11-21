import { getEnv } from './env.ts';
import { getDb } from '../db/sqlite.ts';

export interface SelfHostedRuntimeConfig {
  inferenceMode: 'auto' | 'local-ollama' | 'vllm' | 'gemini';
  selfHostedBaseUrl: string;
  selfHostedModel: string;
  vllmBaseUrl: string;
  vllmModelId: string;
  activeAdapterVersion: string;
}

export function getSelfHostedRuntimeConfig(): SelfHostedRuntimeConfig {
  const env = getEnv();
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM runtime_settings').all() as Array<{
    key: string;
    value: string;
  }>;
  const map = new Map(rows.map((r) => [r.key, r.value]));

  const prodModel = db
    .prepare(`SELECT adapter_version FROM model_versions WHERE deployment_status = 'production' LIMIT 1`)
    .get() as { adapter_version: string } | undefined;

  return {
    inferenceMode: (map.get('inferenceMode') as SelfHostedRuntimeConfig['inferenceMode']) ?? env.CODIZ_INFERENCE_MODE,
    selfHostedBaseUrl: map.get('selfHostedBaseUrl') ?? env.LOCAL_LLM_BASE_URL,
    selfHostedModel: map.get('selfHostedModel') ?? env.LOCAL_LLM_MODEL,
    vllmBaseUrl: map.get('vllmBaseUrl') ?? env.VLLM_BASE_URL,
    vllmModelId: map.get('vllmModelId') ?? env.VLLM_MODEL_ID,
    activeAdapterVersion: prodModel?.adapter_version ?? 'base',
  };
}

export function saveSelfHostedRuntimeConfig(
  patch: Partial<Omit<SelfHostedRuntimeConfig, 'activeAdapterVersion'>>
): SelfHostedRuntimeConfig {
  const db = getDb();
  const now = new Date().toISOString();
  const upsert = db.prepare(
    `INSERT INTO runtime_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  );

  const tx = db.transaction(() => {
    if (patch.inferenceMode !== undefined) upsert.run('inferenceMode', patch.inferenceMode, now);
    if (patch.selfHostedBaseUrl !== undefined)
      upsert.run('selfHostedBaseUrl', patch.selfHostedBaseUrl, now);
    if (patch.selfHostedModel !== undefined)
      upsert.run('selfHostedModel', patch.selfHostedModel, now);
    if (patch.vllmBaseUrl !== undefined) upsert.run('vllmBaseUrl', patch.vllmBaseUrl, now);
    if (patch.vllmModelId !== undefined) upsert.run('vllmModelId', patch.vllmModelId, now);
  });
  tx();

  return getSelfHostedRuntimeConfig();
}
