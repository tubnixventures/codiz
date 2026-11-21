import React, { useEffect, useState } from 'react';
import { FolderTree, Search, ShieldAlert, CheckCircle2, XCircle } from 'lucide-react';
import { apiClient } from '../api.ts';

interface IndexedFile {
  relativePath: string;
  language: string;
  sizeBytes: number;
  lineCount: number;
  symbols: string[];
  imports: string[];
}

interface RepoIndexSnapshot {
  rootName: string;
  indexedAt: string;
  totalFiles: number;
  totalLines: number;
  languages: Record<string, number>;
  files: IndexedFile[];
}

interface ApprovalRow {
  id: string;
  tool_name: string;
  action_summary: string;
  risk_level: string;
  status: string;
  created_at: string;
}

export const RepoView: React.FC = () => {
  const [snapshot, setSnapshot] = useState<RepoIndexSnapshot | null>(null);
  const [filter, setFilter] = useState('');
  const [selectedFile, setSelectedFile] = useState<{ path: string; content: string } | null>(null);
  const [compressQuery, setCompressQuery] = useState('Hono auth middleware and budget');
  const [compressedResult, setCompressedResult] = useState<{
    estimatedTokens: number;
    totalRepoFiles: number;
    compressionRatio: number;
    selectedFiles: Array<{ path: string; score: number }>;
  } | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [loading, setLoading] = useState(true);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [idx, apr] = await Promise.all([
        apiClient.request<RepoIndexSnapshot>('/api/repo/index'),
        apiClient.request<{ approvals: ApprovalRow[] }>('/api/repo/approvals'),
      ]);
      setSnapshot(idx);
      setApprovals(apr.approvals);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
  }, []);

  const openFile = async (relPath: string) => {
    const res = await apiClient.request<{ path: string; content: string }>(
      `/api/repo/file?path=${encodeURIComponent(relPath)}`
    );
    setSelectedFile(res);
  };

  const runCompressionTest = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await apiClient.request<{
      estimatedTokens: number;
      totalRepoFiles: number;
      compressionRatio: number;
      selectedFiles: Array<{ path: string; score: number }>;
    }>('/api/repo/context', {
      method: 'POST',
      body: JSON.stringify({ query: compressQuery, maxTokenBudget: 1800 }),
    });
    setCompressedResult(res);
  };

  const resolveApproval = async (id: string, decision: 'approve' | 'reject') => {
    await apiClient.request(`/api/repo/approvals/${id}`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    });
    await loadAll();
  };

  const filteredFiles = (snapshot?.files ?? []).filter((f) =>
    f.relativePath.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div className="space-y-6">
      {/* Top Metric Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">Indexed Repository</div>
          <div className="text-lg font-semibold text-slate-900 dark:text-slate-100 mt-1 truncate">
            {snapshot?.rootName ?? 'Loading...'}
          </div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">Source Files</div>
          <div className="text-lg font-semibold font-mono tabular-nums text-slate-900 dark:text-slate-100 mt-1">
            {snapshot?.totalFiles ?? 0}
          </div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">Indexed Lines</div>
          <div className="text-lg font-semibold font-mono tabular-nums text-slate-900 dark:text-slate-100 mt-1">
            {(snapshot?.totalLines ?? 0).toLocaleString()}
          </div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">Pending Write Approvals</div>
          <div className="text-lg font-semibold font-mono tabular-nums text-slate-900 dark:text-slate-100 mt-1">
            {approvals.filter((a) => a.status === 'pending').length}
          </div>
        </div>
      </div>

      {/* Context Compression Bench */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              4B Context Compression Selector
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Selects only high-signal files and symbols within a strict token budget so 4B models handle large codebases cheaply.
            </p>
          </div>
        </div>

        <form onSubmit={runCompressionTest} className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            value={compressQuery}
            onChange={(e) => setCompressQuery(e.target.value)}
            className="flex-1 px-3.5 py-2 text-sm bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
            placeholder="Describe a coding task to preview compressed repo context..."
          />
          <button
            type="submit"
            className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium whitespace-nowrap shrink-0"
          >
            Test Context Selection
          </button>
        </form>

        {compressedResult && (
          <div className="mt-4 pt-4 border-t border-slate-100 dark:border-slate-800 text-xs space-y-2">
            <div className="flex flex-wrap gap-4 text-slate-600 dark:text-slate-300 font-mono tabular-nums">
              <span>Selected: {compressedResult.selectedFiles.length} / {compressedResult.totalRepoFiles} files</span>
              <span>Estimated tokens: {compressedResult.estimatedTokens}</span>
              <span>Compression ratio: {(compressedResult.compressionRatio * 100).toFixed(1)}%</span>
            </div>
            <div className="flex flex-wrap gap-2 text-slate-700 dark:text-slate-300 font-mono">
              {compressedResult.selectedFiles.map((f) => (
                <button
                  key={f.path}
                  onClick={() => openFile(f.path)}
                  className="px-2.5 py-1 rounded bg-slate-100 dark:bg-slate-800 hover:bg-emerald-500/15"
                >
                  {f.path} (score {f.score})
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* File Table + Code Inspector */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 flex flex-col max-h-[520px]">
          <div className="flex items-center justify-between gap-3 mb-3">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
              <FolderTree className="w-4 h-4 text-emerald-500" />
              Indexed Files & Symbols
            </h2>
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter path..."
                className="pl-8 pr-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
            {loading ? (
              <div className="py-8 text-xs text-slate-500 text-center">Indexing workspace...</div>
            ) : (
              filteredFiles.map((f) => (
                <button
                  key={f.relativePath}
                  onClick={() => openFile(f.relativePath)}
                  className="w-full text-left py-2.5 px-2 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="text-xs font-mono text-slate-900 dark:text-slate-100 truncate">
                      {f.relativePath}
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate mt-0.5">
                      {f.language}
                      {f.symbols.length > 0 && ` · symbols: ${f.symbols.slice(0, 4).join(', ')}`}
                    </div>
                  </div>
                  <span className="text-[11px] font-mono tabular-nums text-slate-500 shrink-0">
                    {f.lineCount}L
                  </span>
                </button>
              ))
            )}
          </div>
        </div>

        <div className="lg:col-span-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 flex flex-col max-h-[520px]">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-3 truncate">
            {selectedFile ? selectedFile.path : 'Select a file to inspect source'}
          </h2>
          <pre className="flex-1 overflow-auto p-3.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-xs font-mono text-slate-800 dark:text-slate-200 leading-relaxed">
            {selectedFile
              ? selectedFile.content
              : 'Click any file in the repository index to inspect its contents inside the sandbox.'}
          </pre>
        </div>
      </div>

      {/* Sandboxed Approval Queue */}
      {approvals.length > 0 && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2 mb-3">
            <ShieldAlert className="w-4 h-4 text-amber-500" />
            Sandboxed Agent Write Approvals
          </h2>
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {approvals.map((a) => (
              <div key={a.id} className="py-3 flex items-center justify-between gap-4">
                <div>
                  <div className="text-xs font-medium text-slate-900 dark:text-slate-100">
                    {a.action_summary}
                  </div>
                  <div className="text-[11px] text-slate-500 font-mono mt-0.5">
                    {a.tool_name} · risk: {a.risk_level} · status: {a.status}
                  </div>
                </div>
                {a.status === 'pending' && (
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => resolveApproval(a.id, 'approve')}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Approve Write
                    </button>
                    <button
                      onClick={() => resolveApproval(a.id, 'reject')}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-300"
                    >
                      <XCircle className="w-3.5 h-3.5" />
                      Reject
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
