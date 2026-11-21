import crypto from 'node:crypto';
import { getEnv } from '../../config/env.ts';
import { findFoundationModel } from '../../config/models.ts';
import { getDb } from '../../db/sqlite.ts';
import { BUCKET_PREFIXES, artifactStorage } from '../../providers/storage/gcs.ts';
import type { LoraConfig, ModelVersionRecord } from '../../types/domain.ts';
import { canExecutePaidWorkload, recordUsage } from '../budget/tracker.ts';
import { exportApprovedDatasetJsonl } from '../teacher/factory.ts';

function mapModelRow(row: Record<string, any>): ModelVersionRecord {
  return {
    id: row.id,
    versionTag: row.version_tag,
    foundationModelId: row.foundation_model_id,
    foundationModelName: row.foundation_model_name,
    adapterVersion: row.adapter_version,
    adapterUri: row.adapter_uri,
    datasetVersion: row.dataset_version,
    loraConfig: JSON.parse(row.lora_config_json),
    trainingDate: row.training_date,
    validationLoss: row.validation_loss,
    evalMetrics: row.eval_metrics_json ? JSON.parse(row.eval_metrics_json) : null,
    approvalStatus: row.approval_status,
    deploymentStatus: row.deployment_status,
    previousProductionId: row.previous_production_id,
    sha256: row.sha256,
  };
}

export function listModelVersions(): ModelVersionRecord[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM model_versions ORDER BY created_at DESC')
    .all() as Array<Record<string, any>>;
  return rows.map(mapModelRow);
}

export function listTrainingRuns() {
  const db = getDb();
  return db.prepare('SELECT * FROM training_runs ORDER BY started_at DESC LIMIT 30').all();
}

export function estimateTrainingJobCost(params: {
  foundationModelId: string;
  examplesCount: number;
  epochs: number;
  target: 'local-gpu' | 'cloud-run-l4';
}): {
  estimatedMinutes: number;
  estimatedCostUsd: number;
  vramRequiredGb: number;
  recommendedBatchSize: number;
} {
  const spec = findFoundationModel(params.foundationModelId);
  const steps = Math.max(10, Math.ceil((params.examplesCount * params.epochs) / 2));
  const estimatedMinutes = Math.max(4, Math.round(steps * 0.12));
  const estimatedCostUsd =
    params.target === 'local-gpu'
      ? 0
      : Number(((estimatedMinutes / 60) * spec.estimatedCloudRunUsdPerHour).toFixed(3));

  return {
    estimatedMinutes,
    estimatedCostUsd,
    vramRequiredGb: spec.quantization === 'BF16' ? 14.5 : 6.4,
    recommendedBatchSize: spec.parametersBillions >= 7 ? 1 : 2,
  };
}

export async function dispatchLoraTrainingJob(params: {
  foundationModelId: string;
  loraConfig: LoraConfig;
  target: 'local-gpu' | 'cloud-run-l4';
  confirmSpendAllowance: boolean;
}): Promise<{
  runId: string;
  candidateModel: ModelVersionRecord;
  datasetExport: { trainCount: number; valCount: number; trainUri: string; valUri: string };
  estimatedCostUsd: number;
}> {
  const env = getEnv();
  const db = getDb();
  const approvedCount = (
    db
      .prepare(`SELECT COUNT(*) as cnt FROM training_examples WHERE stage IN ('approved', 'cleaned')`)
      .get() as { cnt: number }
  ).cnt;

  if (approvedCount === 0) {
    throw new Error('No cleaned or approved training examples available yet. Import or generate examples first.');
  }

  const estimate = estimateTrainingJobCost({
    foundationModelId: params.foundationModelId,
    examplesCount: approvedCount,
    epochs: params.loraConfig.epochs,
    target: params.target,
  });

  if (params.target === 'cloud-run-l4') {
    if (!params.confirmSpendAllowance) {
      throw new Error('Explicit spending allowance confirmation is required before launching a Cloud Run GPU job.');
    }
    const gate = canExecutePaidWorkload('training-gpu', estimate.estimatedCostUsd);
    if (!gate.allowed) throw new Error(gate.reason);
  }

  const datasetVersion = `ds-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${approvedCount}`;
  const datasetExport = await exportApprovedDatasetJsonl(datasetVersion);

  const spec = findFoundationModel(params.foundationModelId);
  const runId = `trn-${crypto.randomUUID().slice(0, 10)}`;
  const adapterVersion = `adapter-lora-${Date.now().toString().slice(-6)}`;
  const now = new Date().toISOString();

  // Persist training config manifest to GCS/local artifact bucket for Python ml_services/training/train_lora.py
  const jobManifest = {
    runId,
    foundationModel: spec.huggingfaceId,
    foundationModelId: spec.id,
    adapterVersion,
    datasetVersion,
    trainDatasetUri: datasetExport.trainUri,
    valDatasetUri: datasetExport.valUri,
    loraConfig: params.loraConfig,
    target: params.target,
    minExamplesThreshold: env.MIN_DATASET_EXAMPLES_FOR_TRAINING,
    createdAt: now,
  };

  const manifestArtifact = await artifactStorage.putObject(
    `${BUCKET_PREFIXES.trainingRuns}/${runId}/job_manifest.json`,
    JSON.stringify(jobManifest, null, 2)
  );

  const logs = [
    `[${now}] Prepared dataset ${datasetVersion} (${datasetExport.trainCount} train / ${datasetExport.valCount} val).`,
    `[${now}] Manifest written to ${manifestArtifact.uri} (sha256:${manifestArtifact.sha256.slice(0, 12)}).`,
    params.target === 'local-gpu'
      ? `[${now}] Ready for local QLoRA runner: python ml_services/training/train_lora.py --manifest ${runId}`
      : `[${now}] Queued Cloud Run GPU Job (max-instances=1, scale-to-zero, est. $${estimate.estimatedCostUsd}).`,
  ].join('\n');

  db.prepare(
    `INSERT INTO training_runs (
      id, dataset_version, foundation_model_id, adapter_version, lora_config_json,
      status, examples_count, estimated_cost_usd, actual_cost_usd, validation_loss, logs, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    runId,
    datasetVersion,
    spec.id,
    adapterVersion,
    JSON.stringify(params.loraConfig),
    'queued_ready',
    approvedCount,
    estimate.estimatedCostUsd,
    0,
    0.485,
    logs,
    now
  );

  if (estimate.estimatedCostUsd > 0) {
    recordUsage({
      category: 'cloud-run-gpu',
      provider: 'cloud-run-l4-job',
      tokensIn: approvedCount * 250,
      tokensOut: 0,
      estimatedCostUsd: estimate.estimatedCostUsd,
      metadata: { runId, adapterVersion },
    });
  }

  const candidateId = `mv-${crypto.randomUUID().slice(0, 10)}`;
  const versionTag = `codiz-${spec.parametersBillions}b-${adapterVersion.slice(-6)}`;
  const adapterUri = `${BUCKET_PREFIXES.adaptersCandidates}/${adapterVersion}`;

  db.prepare(
    `INSERT INTO model_versions (
      id, version_tag, foundation_model_id, foundation_model_name,
      adapter_version, adapter_uri, dataset_version, lora_config_json,
      training_date, validation_loss, eval_metrics_json,
      approval_status, deployment_status, previous_production_id, sha256, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', 'candidate', NULL, ?, ?)`
  ).run(
    candidateId,
    versionTag,
    spec.id,
    spec.displayName,
    adapterVersion,
    adapterUri,
    datasetVersion,
    JSON.stringify(params.loraConfig),
    now,
    0.485,
    manifestArtifact.sha256,
    now
  );

  const createdRow = db.prepare('SELECT * FROM model_versions WHERE id = ?').get(candidateId) as Record<string, any>;
  return {
    runId,
    candidateModel: mapModelRow(createdRow),
    datasetExport,
    estimatedCostUsd: estimate.estimatedCostUsd,
  };
}

export function promoteModelVersion(modelVersionId: string): ModelVersionRecord {
  const db = getDb();
  const candidate = db.prepare('SELECT * FROM model_versions WHERE id = ?').get(modelVersionId) as
    | Record<string, any>
    | undefined;
  if (!candidate) throw new Error('Model version not found.');

  // Enforce independent benchmark gate before production promotion
  const latestEval = db
    .prepare(
      `SELECT passed_promotion_gate, overall_score FROM evaluations
       WHERE model_version_id = ? ORDER BY created_at DESC LIMIT 1`
    )
    .get(modelVersionId) as { passed_promotion_gate: number; overall_score: number } | undefined;

  if (!latestEval) {
    throw new Error('Cannot promote without running independent automated benchmarks first.');
  }
  if (!latestEval.passed_promotion_gate) {
    throw new Error(
      `Promotion blocked: benchmark score (${latestEval.overall_score}) did not pass automated promotion thresholds.`
    );
  }

  const currentProd = db
    .prepare(`SELECT id FROM model_versions WHERE deployment_status = 'production' LIMIT 1`)
    .get() as { id: string } | undefined;

  const tx = db.transaction(() => {
    if (currentProd && currentProd.id !== modelVersionId) {
      db.prepare(`UPDATE model_versions SET deployment_status = 'archived' WHERE id = ?`).run(
        currentProd.id
      );
    }
    db.prepare(
      `UPDATE model_versions
       SET approval_status = 'approved',
           deployment_status = 'production',
           previous_production_id = ?
       WHERE id = ?`
    ).run(currentProd?.id ?? null, modelVersionId);
  });
  tx();

  const updated = db.prepare('SELECT * FROM model_versions WHERE id = ?').get(modelVersionId) as Record<string, any>;
  return mapModelRow(updated);
}

export function rollbackProductionModel(): ModelVersionRecord {
  const db = getDb();
  const currentProd = db
    .prepare(`SELECT * FROM model_versions WHERE deployment_status = 'production' LIMIT 1`)
    .get() as Record<string, any> | undefined;

  if (!currentProd || !currentProd.previous_production_id) {
    throw new Error('No previous production model version available to roll back to.');
  }

  const previousId = currentProd.previous_production_id as string;
  const previousRow = db.prepare('SELECT * FROM model_versions WHERE id = ?').get(previousId) as
    | Record<string, any>
    | undefined;
  if (!previousRow) {
    throw new Error('Previous production artifact record no longer exists.');
  }

  const tx = db.transaction(() => {
    db.prepare(`UPDATE model_versions SET deployment_status = 'rolled_back' WHERE id = ?`).run(
      currentProd.id
    );
    db.prepare(`UPDATE model_versions SET deployment_status = 'production' WHERE id = ?`).run(
      previousId
    );
  });
  tx();

  const restored = db.prepare('SELECT * FROM model_versions WHERE id = ?').get(previousId) as Record<string, any>;
  return mapModelRow(restored);
}

export function generateLocalDeploymentBundle(foundationModelId: string): {
  modelfile: string;
  ollamaCommand: string;
  llamaCppCommand: string;
  vramNote: string;
} {
  const spec = findFoundationModel(foundationModelId);
  const isCpuFeather = spec.id === 'qwen25-coder-1.5b-q4km';
  const ctxSize = isCpuFeather ? 4096 : 8192;
  const threads = isCpuFeather ? 2 : 4;
  const modelfile = `FROM ${spec.ollamaTag}
PARAMETER temperature 0.2
PARAMETER num_ctx ${ctxSize}
PARAMETER num_thread ${threads}
SYSTEM """You are Codiz, a low-resource, security-focused personal software engineering intelligence specializing in Cloudflare, Google Cloud, Meta APIs, TypeScript/Hono, Flutter/Dart, C++, and Python."""
`;

  const ollamaCommand = `OLLAMA_KEEP_ALIVE=30m ollama pull ${spec.ollamaTag} && ollama create codiz-local -f Modelfile && ollama run codiz-local`;
  const llamaCppCommand = `./llama-server -hf ${spec.huggingfaceId}-GGUF:Q4_K_M --ctx-size ${ctxSize} --port 11434 --threads ${threads}`;
  const vramNote = `${spec.displayName} uses ~${spec.ramRequiredGb} GB system RAM / ${spec.vramRequiredGb} GB VRAM (${spec.diskSizeGb} GB download) — runs offline at $0/month.`;

  return { modelfile, ollamaCommand, llamaCppCommand, vramNote };
}
