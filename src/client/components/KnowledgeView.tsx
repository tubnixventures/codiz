import React, { useEffect, useState } from 'react';
import { BookOpen, Globe, Plus, Search } from 'lucide-react';
import { apiClient } from '../api.ts';

interface KnowledgeHit {
  chunkId: string;
  collection: string;
  title: string;
  sourceUrl: string;
  content: string;
  codeBlocks: string[];
  score: number;
}

export const KnowledgeView: React.FC = () => {
  const [collections, setCollections] = useState<string[]>([]);
  const [activeCollection, setActiveCollection] = useState<string>('all');
  const [query, setQuery] = useState('Cloudflare D1 parameterized query');
  const [hits, setHits] = useState<KnowledgeHit[]>([]);
  const [docCount, setDocCount] = useState(0);

  const [ingestUrl, setIngestUrl] = useState('');
  const [ingestCollection, setIngestCollection] = useState('cloudflare');
  const [manualTitle, setManualTitle] = useState('');
  const [manualContent, setManualContent] = useState('');
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadMetaAndSearch = async (q = query, col = activeCollection) => {
    const [colRes, docRes, searchRes] = await Promise.all([
      apiClient.request<{ collections: string[] }>('/api/knowledge/collections'),
      apiClient.request<{ documents: Array<unknown> }>('/api/knowledge/documents'),
      apiClient.request<{ hits: KnowledgeHit[] }>(
        `/api/knowledge/search?q=${encodeURIComponent(q)}&collection=${encodeURIComponent(col)}`
      ),
    ]);
    setCollections(colRes.collections);
    setDocCount(docRes.documents.length);
    setHits(searchRes.hits);
  };

  useEffect(() => {
    loadMetaAndSearch();
  }, []);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await apiClient.request<{ hits: KnowledgeHit[] }>(
      `/api/knowledge/search?q=${encodeURIComponent(query)}&collection=${encodeURIComponent(activeCollection)}`
    );
    setHits(res.hits);
  };

  const handleScrape = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setStatusMsg(null);
    try {
      const res = await apiClient.request<{ chunkCount: number; gcsUri: string; deduplicated: boolean }>(
        '/api/knowledge/scrape',
        {
          method: 'POST',
          body: JSON.stringify({ url: ingestUrl, collection: ingestCollection }),
        }
      );
      setStatusMsg(
        res.deduplicated
          ? 'Document already indexed (deduplicated by SHA-256).'
          : `Ingested ${res.chunkCount} chunks to ${res.gcsUri}.`
      );
      setIngestUrl('');
      await loadMetaAndSearch();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scrape blocked or failed');
    }
  };

  const handleManualIngest = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setStatusMsg(null);
    try {
      const res = await apiClient.request<{ chunkCount: number; gcsUri: string }>(
        '/api/knowledge/ingest',
        {
          method: 'POST',
          body: JSON.stringify({
            collection: ingestCollection,
            title: manualTitle,
            rawContent: manualContent,
          }),
        }
      );
      setStatusMsg(`Stored ${res.chunkCount} chunks in ${res.gcsUri}.`);
      setManualTitle('');
      setManualContent('');
      await loadMetaAndSearch();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ingestion failed');
    }
  };

  return (
    <div className="space-y-6">
      {/* Search Bar & Collection Tabs */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Hybrid Documentation RAG ({docCount} archived documents)
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Keeps your 4B coding model accurate on current SDKs without costly retraining.
            </p>
          </div>
        </div>

        <form onSubmit={handleSearch} className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search Cloudflare Workers, Cloud Run, Meta webhooks, Flutter..."
              className="w-full pl-9 pr-3 py-2 text-sm bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg"
            />
          </div>
          <select
            value={activeCollection}
            onChange={(e) => {
              setActiveCollection(e.target.value);
              loadMetaAndSearch(query, e.target.value);
            }}
            className="px-3 py-2 text-sm bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg"
          >
            <option value="all">All 20 Collections</option>
            {collections.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium whitespace-nowrap shrink-0"
          >
            Search Docs
          </button>
        </form>

        {/* Results */}
        <div className="space-y-3 pt-2">
          {hits.length === 0 ? (
            <div className="text-xs text-slate-500 py-4 text-center">
              No matching documentation chunks found. Try broader terms or ingest new docs below.
            </div>
          ) : (
            hits.map((h) => (
              <div
                key={h.chunkId}
                className="p-4 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                    <BookOpen className="w-3.5 h-3.5 text-emerald-500" />
                    <span>{h.title}</span>
                  </div>
                  <div className="text-[11px] font-mono text-slate-500">
                    {h.collection} · score {h.score}
                  </div>
                </div>
                <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
                  {h.content}
                </p>
                {h.codeBlocks.length > 0 && (
                  <pre className="p-2.5 rounded bg-slate-900 text-slate-100 text-[11px] font-mono overflow-x-auto">
                    {h.codeBlocks[0]}
                  </pre>
                )}
                <div className="text-[11px] text-slate-500 truncate">Source: {h.sourceUrl}</div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Polite Scraper + Manual Markdown Ingest */}
      {error && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-500">
          {error}
        </div>
      )}
      {statusMsg && (
        <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-600 dark:text-emerald-400">
          {statusMsg}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <form
          onSubmit={handleScrape}
          className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3"
        >
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <Globe className="w-4 h-4 text-emerald-500" />
            Polite Official Docs Fetcher (robots.txt + SSRF Guarded)
          </h3>
          <select
            value={ingestCollection}
            onChange={(e) => setIngestCollection(e.target.value)}
            className="w-full px-3 py-2 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg"
          >
            {collections.map((c) => (
              <option key={c} value={c}>
                Collection: {c}
              </option>
            ))}
          </select>
          <input
            type="url"
            required
            value={ingestUrl}
            onChange={(e) => setIngestUrl(e.target.value)}
            placeholder="https://hono.dev/docs/getting-started/cloudflare-workers"
            className="w-full px-3 py-2 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg"
          />
          <button
            type="submit"
            className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-xs font-medium"
          >
            Fetch, Extract & Archive to GCS
          </button>
        </form>

        <form
          onSubmit={handleManualIngest}
          className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3"
        >
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <Plus className="w-4 h-4 text-emerald-500" />
            Offline Markdown / Reference Ingestion
          </h3>
          <input
            type="text"
            required
            value={manualTitle}
            onChange={(e) => setManualTitle(e.target.value)}
            placeholder="Reference title (e.g. Flutter Drift SQLite Offline Sync)"
            className="w-full px-3 py-2 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg"
          />
          <textarea
            rows={3}
            required
            value={manualContent}
            onChange={(e) => setManualContent(e.target.value)}
            placeholder="Paste documentation markdown or code examples..."
            className="w-full p-3 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg"
          />
          <button
            type="submit"
            className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium"
          >
            Chunk & Index Document
          </button>
        </form>
      </div>
    </div>
  );
};
