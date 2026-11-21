import React, { useEffect, useState } from 'react';
import { ArrowUpCircle, CheckCircle2, RotateCcw, ShieldCheck } from 'lucide-react';
import { apiClient } from '../api.ts';

interface ModelVersion {
  id: string;
  versionTag: string;
  foundationModelId: string;
  foundationModelName: string;
  adapterVersion: string;
  adapterUri: string;
  datasetVersion: string;
  trainingDate: string;
  validationLoss: number | null;
  evalMetrics: {
    overallScore: number;
    typecheckPassRate: number;
    securityPassRate: number;
    unitTestPassRate: number;
    apiAccuracyScore: number;
    avgLatencyMs: number;
  } | null;
  approvalStatus: string;
  deploymentStatus: string;
  previousProductionId: string | null;
}

export const RegistryView: React.FC = () => {
  const [models, setModels] = useState<ModelVersion[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Live Code Evaluator
  const [snippet, setSnippet] = useState(
    `export async function fetchUser(db: any, userId: string) {\n  return db.prepare('SELECT id, email FROM users WHERE id = ?').bind(userId).first();\n}`
  );
  const [snippetResult, setSnippetResult] = useState<{
    syntaxValid: boolean;
    diagnostics: string[];
    securityIssues: string[];
    maintainabilityScore: number;
    passed: boolean;
  } | null>(null);

  const loadModels = async () => {
    const res = await apiClient.request<{ models: ModelVersion[] }>('/api/models');
    setModels(res.models);
  };

  useEffect(() => {
    loadModels();
  }, []);

  const runEval = async (id: string) => {
    setError(null);
    setMessage(null);
    setBusyId(id);
    try {
      const res = await apiClient.request<{
        metrics: { overallScore: number };
        passedPromotionGate: boolean;
        reportUri: string;
      }>(`/api/models/${id}/evaluate`, { method: 'POST' });
      setMessage(
        `Benchmark completed: overall ${res.metrics.overallScore}/100 · promotion gate ${
          res.passedPromotionGate ? 'PASSED' : 'BLOCKED'
        } · saved to ${res.reportUri}`
      );
      await loadModels();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Evaluation failed');
    } finally {
      setBusyId(null);
    }
  };

  const promote = async (id: string) => {
    setError(null);
    setMessage(null);
    setBusyId(id);
    try {
      const res = await apiClient.request<{ model: ModelVersion }>(`/api/models/${id}/promote`, {
        method: 'POST',
      });
      setMessage(`Promoted ${res.model.versionTag} to production.`);
      await loadModels();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Promotion blocked');
    } finally {
      setBusyId(null);
    }
  };

  const rollback = async () => {
    setError(null);
    setMessage(null);
    setBusyId('rollback');
    try {
      const res = await apiClient.request<{ model: ModelVersion }>('/api/models/rollback', {
        method: 'POST',
      });
      setMessage(`Rolled back production to ${res.model.versionTag}.`);
      await loadModels();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rollback unavailable');
    } finally {
      setBusyId(null);
    }
  };

  const testSnippet = async () => {
    const res = await apiClient.request<typeof snippetResult>('/api/factory/evaluate-snippet', {
      method: 'POST',
      body: JSON.stringify({ code: snippet, language: 'typescript' }),
    });
    setSnippetResult(res);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Central Model Registry & Promotion Gates
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Models require independent TypeScript, security, and benchmark verification before promotion. Previous versions remain ready for rollback.
          </p>
        </div>
        <button
          onClick={rollback}
          disabled={busyId === 'rollback'}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-medium text-slate-800 dark:text-slate-200 whitespace-nowrap shrink-0"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          Rollback Production
        </button>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-600 dark:text-red-400">
          {error}
        </div>
      )}
      {message && (
        <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-700 dark:text-emerald-300">
          {message}
        </div>
      )}

      {/* Registry Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">
              <th className="py-2.5 pr-4 font-medium">Version</th>
              <th className="py-2.5 px-3 font-medium">Foundation & Adapter</th>
              <th className="py-2.5 px-3 font-medium">Dataset</th>
              <th className="py-2.5 px-3 font-medium text-right">Overall Score</th>
              <th className="py-2.5 px-3 font-medium text-right">Security</th>
              <th className="py-2.5 px-3 font-medium">Status</th>
              <th className="py-2.5 pl-3 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {models.map((m) => (
              <tr key={m.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                <td className="py-3 pr-4 font-mono font-medium text-slate-900 dark:text-slate-100">
                  {m.versionTag}
                </td>
                <td className="py-3 px-3">
                  <div className="text-slate-800 dark:text-slate-200">{m.foundationModelName}</div>
                  <div className="text-[11px] font-mono text-slate-500">{m.adapterVersion}</div>
                </td>
                <td className="py-3 px-3 font-mono text-slate-600 dark:text-slate-300">
                  {m.datasetVersion}
                </td>
                <td className="py-3 px-3 text-right font-mono tabular-nums">
                  {m.evalMetrics ? `${m.evalMetrics.overallScore}/100` : 'Unbenchmarked'}
                </td>
                <td className="py-3 px-3 text-right font-mono tabular-nums">
                  {m.evalMetrics ? `${m.evalMetrics.securityPassRate}%` : '—'}
                </td>
                <td className="py-3 px-3">
                  <span
                    className={`font-medium capitalize ${
                      m.deploymentStatus === 'production'
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : m.deploymentStatus === 'rolled_back'
                          ? 'text-amber-600 dark:text-amber-400'
                          : 'text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    {m.deploymentStatus.replace('_', ' ')}
                  </span>
                </td>
                <td className="py-3 pl-3 text-right space-x-2 whitespace-nowrap">
                  <button
                    onClick={() => runEval(m.id)}
                    disabled={busyId === m.id}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 hover:border-emerald-500 text-xs font-medium"
                  >
                    <ShieldCheck className="w-3.5 h-3.5" />
                    Benchmark
                  </button>
                  {m.deploymentStatus !== 'production' && (
                    <button
                      onClick={() => promote(m.id)}
                      disabled={busyId === m.id}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium"
                    >
                      <ArrowUpCircle className="w-3.5 h-3.5" />
                      Promote
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Live Automated Static & Security Evaluator */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Automated Code & Security Gate Sandbox
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Runs real TypeScript strict compiler diagnostics and security smell detection on student/teacher outputs.
            </p>
          </div>
          <button
            onClick={testSnippet}
            className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-xs font-medium whitespace-nowrap shrink-0"
          >
            Run Static Gate
          </button>
        </div>

        <textarea
          rows={5}
          value={snippet}
          onChange={(e) => setSnippet(e.target.value)}
          className="w-full p-3 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-800 dark:text-slate-200"
        />

        {snippetResult && (
          <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-xs space-y-1.5">
            <div className="flex items-center gap-2 font-medium">
              <CheckCircle2
                className={`w-4 h-4 ${
                  snippetResult.passed ? 'text-emerald-500' : 'text-red-500'
                }`}
              />
              <span>
                Gate Status: {snippetResult.passed ? 'PASSED' : 'FAILED'} · Maintainability:{' '}
                <span className="font-mono tabular-nums">{snippetResult.maintainabilityScore}/100</span>
              </span>
            </div>
            {snippetResult.diagnostics.map((d, i) => (
              <div key={i} className="text-red-500 font-mono">
                TS Diagnostic: {d}
              </div>
            ))}
            {snippetResult.securityIssues.map((s, i) => (
              <div key={i} className="text-amber-500 font-mono">
                Security Check: {s}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
