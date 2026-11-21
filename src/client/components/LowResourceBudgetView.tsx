import React, { useEffect, useState } from 'react';
import { Check, Code2, Copy, HardDrive, Laptop, Server, Wallet } from 'lucide-react';
import { apiClient, formatCurrency } from '../api.ts';

interface FoundationModelSpec {
  id: string;
  displayName: string;
  parametersBillions: number;
  quantization: string;
  ramRequiredGb: number;
  vramRequiredGb: number;
  diskSizeGb: number;
  contextWindow: number;
  recommendedFor: string;
  estimatedCloudRunUsdPerHour: number;
  tier: string;
}

interface BudgetResponse {
  budget: {
    monthKey: string;
    monthlyBudgetUsd: number;
    totalSpentUsd: number;
    percentUsed: number;
    thresholdState: string;
    breakdown: {
      teacherApiUsd: number;
      cloudRunGpuUsd: number;
      gcsStorageUsd: number;
      embeddingsUsd: number;
    };
    localSavingsUsd: number;
    dailyTeacherCalls: number;
    maxDailyTeacherCalls: number;
    advisoryNotice: string;
  };
  storage: {
    backend: string;
    bucketName: string;
    totalLocalBytes: number;
    objectCount: number;
  };
}

interface LowResourceBudgetViewProps {
  currency: string;
  rates: Record<string, { symbol: string; name: string; perUsd: number }>;
  budgetData: BudgetResponse | null;
}

export const LowResourceBudgetView: React.FC<LowResourceBudgetViewProps> = ({
  currency,
  rates,
  budgetData,
}) => {
  const [catalog, setCatalog] = useState<FoundationModelSpec[]>([]);
  const [selectedModelId, setSelectedModelId] = useState('qwen3-4b-q4km');
  const [bundle, setBundle] = useState<{
    modelfile: string;
    ollamaCommand: string;
    llamaCppCommand: string;
    vramNote: string;
  } | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const [runtimeCfg, setRuntimeCfg] = useState<{
    inferenceMode: 'auto' | 'local-ollama' | 'vllm' | 'gemini';
    selfHostedBaseUrl: string;
    selfHostedModel: string;
    vllmBaseUrl: string;
    vllmModelId: string;
    activeAdapterVersion: string;
  } | null>(null);
  const [savingRuntime, setSavingRuntime] = useState(false);
  const [runtimeMsg, setRuntimeMsg] = useState<string | null>(null);

  useEffect(() => {
    apiClient
      .request<{ catalog: FoundationModelSpec[] }>('/api/models/catalog')
      .then((res) => setCatalog(res.catalog))
      .catch(() => null);
    apiClient
      .request<{ config: NonNullable<typeof runtimeCfg> }>('/api/models/runtime-config')
      .then((res) => setRuntimeCfg(res.config))
      .catch(() => null);
  }, []);

  useEffect(() => {
    apiClient
      .request<typeof bundle>(`/api/models/local-bundle?foundationId=${selectedModelId}`)
      .then(setBundle)
      .catch(() => null);
  }, [selectedModelId]);

  const copyText = async (key: string, val: string) => {
    await navigator.clipboard.writeText(val);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
  };

  const saveRuntimeConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!runtimeCfg) return;
    setSavingRuntime(true);
    setRuntimeMsg(null);
    try {
      const res = await apiClient.request<{ config: NonNullable<typeof runtimeCfg> }>(
        '/api/models/runtime-config',
        {
          method: 'POST',
          body: JSON.stringify({
            inferenceMode: runtimeCfg.inferenceMode,
            selfHostedBaseUrl: runtimeCfg.selfHostedBaseUrl,
            selfHostedModel: runtimeCfg.selfHostedModel,
            vllmBaseUrl: runtimeCfg.vllmBaseUrl,
            vllmModelId: runtimeCfg.vllmModelId,
          }),
        }
      );
      setRuntimeCfg(res.config);
      setRuntimeMsg('Saved self-hosted Qwen routing configuration.');
    } catch (err) {
      setRuntimeMsg(err instanceof Error ? err.message : 'Failed to save configuration');
    } finally {
      setSavingRuntime(false);
    }
  };

  const b = budgetData?.budget;
  const gatewayOrigin = typeof window !== 'undefined' ? window.location.origin : 'https://your-codiz-cloud.run.app';
  const vscodeSettingsSnippet = JSON.stringify(
    {
      'codiz.gatewayUrl': gatewayOrigin,
      'codiz.model': runtimeCfg?.selfHostedModel || 'qwen3:4b-q4_K_M',
      'codiz.useKnowledgeRag': true,
      'codiz.enableInlineCompletions': false,
    },
    null,
    2
  );

  return (
    <div className="space-y-6">
      {/* Self-Hosted Cost & Resource Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">Monthly Cloud Spend</div>
          <div className="text-xl font-semibold font-mono tabular-nums text-slate-900 dark:text-slate-100 mt-1">
            {formatCurrency(b?.totalSpentUsd ?? 0, currency, rates)}
          </div>
          <div className="text-[11px] text-slate-500 font-mono tabular-nums mt-1">
            Cap: {formatCurrency(b?.monthlyBudgetUsd ?? 20, currency, rates)} ({b?.percentUsed ?? 0}%)
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">Self-Hosted Compute Saved</div>
          <div className="text-xl font-semibold font-mono tabular-nums text-emerald-600 dark:text-emerald-400 mt-1">
            {formatCurrency(b?.localSavingsUsd ?? 0, currency, rates)}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            Zero-cost self-hosted Qwen tokens
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">Model Ownership</div>
          <div className="text-base font-semibold text-slate-900 dark:text-slate-100 mt-1 truncate">
            Self-Hosted Qwen
          </div>
          <div className="text-[11px] text-slate-500 font-mono mt-1 truncate">
            Adapter: {runtimeCfg?.activeAdapterVersion ?? 'base'} · No subscriptions
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">Artifact Storage</div>
          <div className="text-sm font-semibold text-slate-900 dark:text-slate-100 mt-1 truncate">
            {budgetData?.storage.backend === 'gcs' ? 'Google Cloud Storage' : 'Local Mirror'}
          </div>
          <div className="text-[11px] text-slate-500 font-mono tabular-nums mt-1">
            {budgetData?.storage.objectCount ?? 0} objects ·{' '}
            {((budgetData?.storage.totalLocalBytes ?? 0) / 1024).toFixed(1)} KB
          </div>
        </div>
      </div>

      {/* Budget Threshold Banner */}
      {b && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
              <Wallet className="w-4 h-4 text-emerald-500" />
              $20/Month Budget Guardrail & Thresholds
            </h2>
            <span className="text-xs font-mono text-slate-600 dark:text-slate-300">
              State: {b.thresholdState} · Teacher calls today: {b.dailyTeacherCalls}/{b.maxDailyTeacherCalls}
            </span>
          </div>

          <div className="w-full h-2.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden mb-3">
            <div
              className={`h-full transition-all ${
                b.percentUsed >= 90
                  ? 'bg-red-500'
                  : b.percentUsed >= 75
                    ? 'bg-amber-500'
                    : 'bg-emerald-500'
              }`}
              style={{ width: `${Math.min(100, Math.max(2, b.percentUsed))}%` }}
            />
          </div>

          <p className="text-xs text-slate-600 dark:text-slate-300 mb-3">{b.advisoryNotice}</p>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-[11px] font-mono text-slate-500 dark:text-slate-400">
            <div>50%: Notification alert</div>
            <div>75%: Prefer local / JSONL</div>
            <div>90%: Stop optional GPU/Teacher</div>
            <div>100%: Pause paid cloud jobs</div>
          </div>
        </div>
      )}

      {/* Low-Resource Foundation Model Hardware Matrix */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2 mb-3">
          <HardDrive className="w-4 h-4 text-emerald-500" />
          Open-Weight Model Resource Matrix (Local & Scale-to-Zero)
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                <th className="py-2 pr-4 font-medium">Model</th>
                <th className="py-2 px-3 font-medium">Quant</th>
                <th className="py-2 px-3 font-medium text-right">RAM</th>
                <th className="py-2 px-3 font-medium text-right">VRAM</th>
                <th className="py-2 px-3 font-medium text-right">Disk</th>
                <th className="py-2 px-3 font-medium text-right">Cloud L4 / hr</th>
                <th className="py-2 pl-3 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {catalog.map((m) => (
                <tr key={m.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                  <td className="py-2.5 pr-4">
                    <div className="font-medium text-slate-900 dark:text-slate-100">
                      {m.displayName}
                    </div>
                    <div className="text-[11px] text-slate-500">{m.recommendedFor}</div>
                  </td>
                  <td className="py-2.5 px-3 font-mono">{m.quantization}</td>
                  <td className="py-2.5 px-3 text-right font-mono tabular-nums">
                    {m.ramRequiredGb} GB
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono tabular-nums">
                    {m.vramRequiredGb} GB
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono tabular-nums">
                    {m.diskSizeGb} GB
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono tabular-nums">
                    {formatCurrency(m.estimatedCloudRunUsdPerHour, currency, rates)}
                  </td>
                  <td className="py-2.5 pl-3 text-right">
                    <button
                      onClick={() => setSelectedModelId(m.id)}
                      className={`px-2.5 py-1 rounded text-xs font-medium whitespace-nowrap ${
                        selectedModelId === m.id
                          ? 'bg-emerald-600 text-white'
                          : 'border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300'
                      }`}
                    >
                      {selectedModelId === m.id ? 'Selected' : 'Generate Setup'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Zero-Cost Local Deployment Bundle */}
      {bundle && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
              <Laptop className="w-4 h-4 text-emerald-500" />
              Zero-Cost Local Deployment Bundle (Offline Ready)
            </h2>
            <p className="text-xs text-slate-600 dark:text-slate-300 mt-1">{bundle.vramNote}</p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs font-medium text-slate-700 dark:text-slate-300">
                <span>1. Save as Modelfile</span>
                <button
                  onClick={() => copyText('modelfile', bundle.modelfile)}
                  className="inline-flex items-center gap-1 text-emerald-600 hover:underline"
                >
                  {copiedKey === 'modelfile' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  Copy
                </button>
              </div>
              <pre className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-[11px] font-mono overflow-x-auto">
                {bundle.modelfile}
              </pre>
            </div>

            <div className="space-y-3">
              <div>
                <div className="flex items-center justify-between text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  <span>2. Run with Ollama (Recommended)</span>
                  <button
                    onClick={() => copyText('ollama', bundle.ollamaCommand)}
                    className="inline-flex items-center gap-1 text-emerald-600 hover:underline"
                  >
                    {copiedKey === 'ollama' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    Copy
                  </button>
                </div>
                <pre className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-[11px] font-mono overflow-x-auto">
                  {bundle.ollamaCommand}
                </pre>
              </div>

              <div>
                <div className="flex items-center justify-between text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  <span>Or Run with llama.cpp (CPU / Ultra-Low RAM)</span>
                  <button
                    onClick={() => copyText('llamacpp', bundle.llamaCppCommand)}
                    className="inline-flex items-center gap-1 text-emerald-600 hover:underline"
                  >
                    {copiedKey === 'llamacpp' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    Copy
                  </button>
                </div>
                <pre className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-[11px] font-mono overflow-x-auto">
                  {bundle.llamaCppCommand}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* Self-Hosted Qwen Endpoint + Separate VS Code Extension Setup */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {runtimeCfg && (
          <form
            onSubmit={saveRuntimeConfig}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3"
          >
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
              <Server className="w-4 h-4 text-emerald-500" />
              Self-Hosted Trained Qwen Endpoint
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Point Codiz Cloud Gateway to your own trained Qwen server (local Ollama, home GPU tunnel, or scale-to-zero Cloud Run vLLM/PEFT service).
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">Routing Mode</label>
                <select
                  value={runtimeCfg.inferenceMode}
                  onChange={(e) =>
                    setRuntimeCfg({ ...runtimeCfg, inferenceMode: e.target.value as any })
                  }
                  className="w-full px-3 py-2 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg"
                >
                  <option value="auto">Auto (Self-Hosted Qwen First)</option>
                  <option value="local-ollama">Self-Hosted Ollama / llama.cpp Only</option>
                  <option value="vllm">Self-Hosted Cloud Run vLLM Only</option>
                  <option value="gemini">Server Gemini Fallback</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">Self-Hosted Qwen Model ID</label>
                <input
                  type="text"
                  value={runtimeCfg.selfHostedModel}
                  onChange={(e) =>
                    setRuntimeCfg({ ...runtimeCfg, selfHostedModel: e.target.value })
                  }
                  placeholder="qwen3:4b-q4_K_M"
                  className="w-full px-3 py-2 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg"
                />
              </div>
            </div>

            <div>
              <label className="block text-[11px] text-slate-500 mb-1">
                Primary Self-Hosted Qwen Base URL (OpenAI-compatible /v1)
              </label>
              <input
                type="url"
                value={runtimeCfg.selfHostedBaseUrl}
                onChange={(e) =>
                  setRuntimeCfg({ ...runtimeCfg, selfHostedBaseUrl: e.target.value })
                }
                placeholder="http://127.0.0.1:11434/v1"
                className="w-full px-3 py-2 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg"
              />
            </div>

            <div>
              <label className="block text-[11px] text-slate-500 mb-1">
                Cloud Run vLLM + LoRA Endpoint URL (Optional)
              </label>
              <input
                type="url"
                value={runtimeCfg.vllmBaseUrl}
                onChange={(e) => setRuntimeCfg({ ...runtimeCfg, vllmBaseUrl: e.target.value })}
                placeholder="https://codiz-inference-xxxx.run.app/v1"
                className="w-full px-3 py-2 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg"
              />
            </div>

            <div className="flex items-center justify-between gap-3 pt-1">
              <span className="text-[11px] text-emerald-600 dark:text-emerald-400">
                {runtimeMsg ?? ''}
              </span>
              <button
                type="submit"
                disabled={savingRuntime}
                className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium whitespace-nowrap shrink-0"
              >
                {savingRuntime ? 'Saving...' : 'Save Self-Hosted Route'}
              </button>
            </div>
          </form>
        )}

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <Code2 className="w-4 h-4 text-emerald-500" />
            Separate VS Code Extension (codiz-vscode)
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Connect the standalone VS Code extension in <code className="font-mono">vscode-extension/</code> to this Codiz Cloud Gateway. It queries your self-hosted trained Qwen model via <code className="font-mono">/api/v1/chat/completions</code> with RAG context.
          </p>

          <div className="text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-3 space-y-1">
            <div className="text-slate-500">OpenAI-compatible IDE endpoint:</div>
            <div className="text-slate-900 dark:text-slate-100 break-all">
              {gatewayOrigin}/api/v1/chat/completions
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
              <span>VS Code settings.json</span>
              <button
                type="button"
                onClick={() => copyText('vscode', vscodeSettingsSnippet)}
                className="inline-flex items-center gap-1 text-emerald-600 hover:underline"
              >
                {copiedKey === 'vscode' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                Copy
              </button>
            </div>
            <pre className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-[11px] font-mono overflow-x-auto">
              {vscodeSettingsSnippet}
            </pre>
          </div>
        </div>
      </div>

      {/* Muse-Code-Style Interactive Terminal CLI (`codiz`) */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <Laptop className="w-4 h-4 text-emerald-500" />
            Interactive Terminal CLI (type <code className="font-mono">codiz</code> in any project)
          </h2>
          <button
            type="button"
            onClick={() =>
              copyText(
                'cliSetup',
                'git clone <YOUR_GITHUB_REPO_URL> codiz\ncd codiz\nnpm install\nnpm link\ncodiz'
              )
            }
            className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 hover:underline"
          >
            {copiedKey === 'cliSetup' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            Copy Commands
          </button>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Clone from GitHub, run <code className="font-mono">npm install &amp;&amp; npm link</code>, and type <code className="font-mono">codiz</code>. No manual web server or manual config needed—Codiz automatically starts local Ollama, tunes <code className="font-mono">codiz-local</code> for your CPU/RAM/HDD, and opens the Muse-Code-style terminal.
        </p>
        <pre className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-[11px] font-mono overflow-x-auto">
{`git clone <YOUR_GITHUB_REPO_URL> codiz
cd codiz
npm install
npm link
codiz                                # opens interactive Muse-Code terminal
codiz chat -p "write a python func"  # one-shot local execution`}
        </pre>
      </div>
    </div>
  );
};
