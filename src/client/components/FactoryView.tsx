import React, { useEffect, useState } from 'react';
import { Cpu, FileUp, Sparkles, Play } from 'lucide-react';
import { apiClient, formatCurrency } from '../api.ts';

interface TrainingExample {
  id: string;
  stage: string;
  category: string;
  difficulty: string;
  source: string;
  attribution: string;
  licenseMetadata: string;
  prompt: string;
  teacherScore: number | null;
  secretsScrubbed: boolean;
  createdAt: string;
}

interface TrainingRun {
  id: string;
  dataset_version: string;
  foundation_model_id: string;
  adapter_version: string;
  status: string;
  examples_count: number;
  estimated_cost_usd: number;
  validation_loss: number | null;
  logs: string;
  started_at: string;
}

interface FactoryViewProps {
  currency: string;
  rates: Record<string, { symbol: string; perUsd: number }>;
  onBudgetChanged: () => void;
}

const SAMPLE_MUSE_JSONL = `{"prompt":"Write a Hono Cloudflare Worker endpoint validating JSON with Zod and querying D1 safely.","completion":"import { Hono } from 'hono';\\nimport { z } from 'zod';\\nconst app = new Hono<{ Bindings: { DB: D1Database } }>();\\napp.post('/items', async (c) => {\\n  const body = z.object({ name: z.string().min(1) }).safeParse(await c.req.json());\\n  if (!body.success) return c.json({ error: 'Invalid' }, 400);\\n  await c.env.DB.prepare('INSERT INTO items (name) VALUES (?)').bind(body.data.name).run();\\n  return c.json({ ok: true }, 201);\\n});\\nexport default app;","category":"cloudflare","difficulty":"intermediate","attribution":"Muse Code Teacher","license":"personal-authorized"}`;

export const FactoryView: React.FC<FactoryViewProps> = ({
  currency,
  rates,
  onBudgetChanged,
}) => {
  const [examples, setExamples] = useState<TrainingExample[]>([]);
  const [runs, setRuns] = useState<TrainingRun[]>([]);
  const [stageFilter, setStageFilter] = useState('all');

  const [jsonlText, setJsonlText] = useState(SAMPLE_MUSE_JSONL);
  const [attribution, setAttribution] = useState('Muse Code Teacher');
  const [licenseMeta, setLicenseMeta] = useState('authorized-personal-export');
  const [importSummary, setImportSummary] = useState<string | null>(null);

  const [synthTopic, setSynthTopic] = useState('Cloudflare Durable Objects WebSocket hibernation');
  const [synthDifficulty, setSynthDifficulty] = useState<'beginner' | 'intermediate' | 'advanced'>('intermediate');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Training Job State
  const [foundationModelId, setFoundationModelId] = useState('qwen3-4b-bf16');
  const [target, setTarget] = useState<'local-gpu' | 'cloud-run-l4'>('local-gpu');
  const [rank, setRank] = useState(16);
  const [epochs, setEpochs] = useState(2);
  const [confirmSpend, setConfirmSpend] = useState(false);
  const [estimate, setEstimate] = useState<{
    estimatedMinutes: number;
    estimatedCostUsd: number;
    vramRequiredGb: number;
  } | null>(null);

  const loadData = async () => {
    const [exRes, runRes] = await Promise.all([
      apiClient.request<{ examples: TrainingExample[] }>(
        `/api/factory/examples?stage=${stageFilter}`
      ),
      apiClient.request<{ runs: TrainingRun[] }>('/api/factory/training/runs'),
    ]);
    setExamples(exRes.examples);
    setRuns(runRes.runs);
  };

  useEffect(() => {
    loadData();
  }, [stageFilter]);

  useEffect(() => {
    const count = Math.max(10, examples.length);
    apiClient
      .request<{ estimatedMinutes: number; estimatedCostUsd: number; vramRequiredGb: number }>(
        `/api/factory/training/estimate?foundationModelId=${foundationModelId}&examplesCount=${count}&epochs=${epochs}&target=${target}`
      )
      .then(setEstimate)
      .catch(() => null);
  }, [foundationModelId, examples.length, epochs, target]);

  const handleMuseImport = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusyAction('import');
    try {
      const res = await apiClient.request<{
        importedCount: number;
        deduplicatedCount: number;
        rejectedCount: number;
        redactedSecretsTotal: number;
      }>('/api/factory/muse-import', {
        method: 'POST',
        body: JSON.stringify({
          jsonlText,
          attribution,
          licenseMetadata: licenseMeta,
        }),
      });
      setImportSummary(
        `Imported ${res.importedCount} new · ${res.deduplicatedCount} deduplicated · ${res.redactedSecretsTotal} secrets scrubbed · ${res.rejectedCount} rejected.`
      );
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Muse Code JSONL import failed');
    } finally {
      setBusyAction(null);
    }
  };

  const handleGenerateSynthetic = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusyAction('synth');
    try {
      await apiClient.request('/api/factory/synthetic', {
        method: 'POST',
        body: JSON.stringify({ topic: synthTopic, difficulty: synthDifficulty }),
      });
      await loadData();
      onBudgetChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Synthetic generation failed');
    } finally {
      setBusyAction(null);
    }
  };

  const handleTeacherReview = async (id: string) => {
    setError(null);
    setBusyAction(`review-${id}`);
    try {
      await apiClient.request(`/api/factory/examples/${id}/teacher-review`, {
        method: 'POST',
      });
      await loadData();
      onBudgetChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Teacher review failed');
    } finally {
      setBusyAction(null);
    }
  };

  const handleDispatchTraining = async () => {
    setError(null);
    setBusyAction('train');
    try {
      await apiClient.request('/api/factory/training/run', {
        method: 'POST',
        body: JSON.stringify({
          foundationModelId,
          target,
          confirmSpendAllowance: confirmSpend,
          loraConfig: {
            rank,
            alpha: rank * 2,
            dropout: 0.05,
            learningRate: 0.0002,
            epochs,
            batchSize: 2,
            quantizationBits: 4,
          },
        }),
      });
      await loadData();
      onBudgetChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Training dispatch failed');
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="space-y-6">
      {error && (
        <div className="p-3.5 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Top Row: Muse Code Importer + AI Teacher Synthetic Generator */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <form
          onSubmit={handleMuseImport}
          className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
              <FileUp className="w-4 h-4 text-emerald-500" />
              Muse Code & Teacher JSONL Importer
            </h2>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Imports authorized JSONL exports, scrubs secrets/emails, deduplicates hashes, and preserves attribution metadata before entering LoRA datasets.
          </p>

          <div className="grid grid-cols-2 gap-3">
            <input
              type="text"
              value={attribution}
              onChange={(e) => setAttribution(e.target.value)}
              placeholder="Attribution"
              className="px-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
            />
            <input
              type="text"
              value={licenseMeta}
              onChange={(e) => setLicenseMeta(e.target.value)}
              placeholder="License metadata"
              className="px-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
            />
          </div>

          <textarea
            rows={4}
            value={jsonlText}
            onChange={(e) => setJsonlText(e.target.value)}
            className="w-full p-3 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-800 dark:text-slate-200"
          />

          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] text-emerald-600 dark:text-emerald-400">
              {importSummary ?? ''}
            </span>
            <button
              type="submit"
              disabled={busyAction === 'import'}
              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-medium whitespace-nowrap shrink-0"
            >
              {busyAction === 'import' ? 'Importing...' : 'Run Quality Pipeline & Import'}
            </button>
          </div>
        </form>

        {/* Synthetic Generator + LoRA Dispatcher */}
        <div className="space-y-6">
          <form
            onSubmit={handleGenerateSynthetic}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3"
          >
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-emerald-500" />
              AI Teacher Synthetic Example Generator
            </h2>
            <div className="flex flex-col sm:flex-row gap-2.5">
              <input
                type="text"
                value={synthTopic}
                onChange={(e) => setSynthTopic(e.target.value)}
                className="flex-1 px-3 py-2 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
                placeholder="Topic (e.g. Google Cloud Run IAM + Secret Manager)"
              />
              <select
                value={synthDifficulty}
                onChange={(e) => setSynthDifficulty(e.target.value as any)}
                className="px-3 py-2 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
              >
                <option value="beginner">Beginner</option>
                <option value="intermediate">Intermediate</option>
                <option value="advanced">Advanced</option>
              </select>
              <button
                type="submit"
                disabled={busyAction === 'synth'}
                className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-xs font-medium whitespace-nowrap shrink-0"
              >
                {busyAction === 'synth' ? 'Generating...' : 'Generate Pair'}
              </button>
            </div>
          </form>

          {/* QLoRA Job Dispatcher */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
              <Cpu className="w-4 h-4 text-emerald-500" />
              Automated QLoRA Training Dispatcher
            </h2>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">Base Model</label>
                <select
                  value={foundationModelId}
                  onChange={(e) => setFoundationModelId(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg"
                >
                  <option value="qwen3-4b-bf16">Qwen3-4B (QLoRA)</option>
                  <option value="qwen25-coder-3b-q4km">Qwen2.5-3B</option>
                  <option value="qwen25-coder-7b-awq">Qwen2.5-7B</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">Compute Target</label>
                <select
                  value={target}
                  onChange={(e) => setTarget(e.target.value as any)}
                  className="w-full px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg"
                >
                  <option value="local-gpu">Local GPU ($0)</option>
                  <option value="cloud-run-l4">Cloud Run L4</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">LoRA Rank</label>
                <select
                  value={rank}
                  onChange={(e) => setRank(Number(e.target.value))}
                  className="w-full px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg font-mono"
                >
                  <option value={8}>r = 8 (Low VRAM)</option>
                  <option value={16}>r = 16 (Balanced)</option>
                  <option value={32}>r = 32 (High Cap)</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">Epochs</label>
                <input
                  type="number"
                  min={1}
                  max={6}
                  value={epochs}
                  onChange={(e) => setEpochs(Number(e.target.value))}
                  className="w-full px-2.5 py-1.5 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg"
                />
              </div>
            </div>

            {estimate && (
              <div className="text-xs font-mono tabular-nums text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-950 p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 flex flex-wrap gap-4">
                <span>Est. duration: {estimate.estimatedMinutes} min</span>
                <span>VRAM needed: {estimate.vramRequiredGb} GB</span>
                <span>
                  Est. cost: {formatCurrency(estimate.estimatedCostUsd, currency, rates)}
                </span>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3">
              {target === 'cloud-run-l4' ? (
                <label className="flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={confirmSpend}
                    onChange={(e) => setConfirmSpend(e.target.checked)}
                  />
                  Confirm Cloud Run L4 spend allowance
                </label>
              ) : (
                <span className="text-xs text-slate-500">Exports GCS/local manifest + candidate adapter</span>
              )}

              <button
                type="button"
                onClick={handleDispatchTraining}
                disabled={busyAction === 'train'}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-medium whitespace-nowrap shrink-0"
              >
                <Play className="w-3.5 h-3.5" />
                {busyAction === 'train' ? 'Dispatching...' : 'Create Training Run'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Dataset Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Dataset Pipeline ({examples.length} examples)
          </h2>
          <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-950 rounded-lg">
            {['all', 'raw', 'cleaned', 'approved'].map((st) => (
              <button
                key={st}
                onClick={() => setStageFilter(st)}
                className={`px-3 py-1 text-xs font-medium rounded-md capitalize ${
                  stageFilter === st
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-sm'
                    : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
              >
                {st}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">
                <th className="py-2.5 pr-4 font-medium">Prompt</th>
                <th className="py-2.5 px-3 font-medium">Category</th>
                <th className="py-2.5 px-3 font-medium">Source</th>
                <th className="py-2.5 px-3 font-medium">Stage</th>
                <th className="py-2.5 px-3 font-medium text-right">Teacher Score</th>
                <th className="py-2.5 pl-3 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {examples.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-slate-500">
                    No training examples in this stage yet. Import Muse Code JSONL or approve a chat reply.
                  </td>
                </tr>
              ) : (
                examples.map((ex) => (
                  <tr key={ex.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="py-2.5 pr-4 max-w-md truncate text-slate-900 dark:text-slate-100">
                      {ex.prompt}
                    </td>
                    <td className="py-2.5 px-3 font-mono text-slate-600 dark:text-slate-300">
                      {ex.category}
                    </td>
                    <td className="py-2.5 px-3 text-slate-500">{ex.source}</td>
                    <td className="py-2.5 px-3 capitalize text-slate-700 dark:text-slate-300">
                      {ex.stage}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono tabular-nums">
                      {ex.teacherScore !== null ? `${ex.teacherScore}/100` : '—'}
                    </td>
                    <td className="py-2.5 pl-3 text-right">
                      <button
                        onClick={() => handleTeacherReview(ex.id)}
                        disabled={busyAction === `review-${ex.id}`}
                        className="px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 hover:border-emerald-500 text-xs font-medium text-slate-700 dark:text-slate-200 whitespace-nowrap"
                      >
                        {busyAction === `review-${ex.id}` ? 'Reviewing...' : 'Teacher Review'}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Training Runs Log */}
      {runs.length > 0 && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-3">
            Dispatched LoRA Training Jobs
          </h2>
          <div className="space-y-3">
            {runs.map((r) => (
              <div
                key={r.id}
                className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
                  <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                    {r.adapter_version} · {r.foundation_model_id}
                  </span>
                  <span className="font-mono tabular-nums text-slate-500">
                    {r.examples_count} examples · est. {formatCurrency(r.estimated_cost_usd, currency, rates)} · status: {r.status}
                  </span>
                </div>
                <pre className="text-[11px] font-mono text-slate-600 dark:text-slate-400 whitespace-pre-wrap">
                  {r.logs}
                </pre>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
