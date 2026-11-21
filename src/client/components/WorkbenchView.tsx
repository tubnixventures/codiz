import React, { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  FileCode2,
  Send,
  ThumbsDown,
  ThumbsUp,
  BookOpen,
  Plus,
} from 'lucide-react';
import { apiClient, formatCurrency } from '../api.ts';

type AgentMode = 'chat' | 'completion' | 'debugging' | 'architecture' | 'review' | 'autonomous';

interface MessageItem {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  mode: string;
  provider_used?: string;
  tokens_in?: number;
  tokens_out?: number;
  context_files_json?: string;
  citations_json?: string;
  feedback_rating?: number | null;
  captured_to_dataset?: number;
}

interface ConversationSummary {
  id: string;
  title: string;
  mode: string;
  updated_at: string;
}

interface WorkbenchViewProps {
  currency: string;
  rates: Record<string, { symbol: string; perUsd: number }>;
  onBudgetChanged: () => void;
}

const MODES: Array<{ id: AgentMode; label: string }> = [
  { id: 'chat', label: 'Chat' },
  { id: 'completion', label: 'Completion' },
  { id: 'debugging', label: 'Debug' },
  { id: 'architecture', label: 'Architecture' },
  { id: 'review', label: 'Review' },
  { id: 'autonomous', label: 'Autonomous' },
];

export const WorkbenchView: React.FC<WorkbenchViewProps> = ({
  currency,
  rates,
  onBudgetChanged,
}) => {
  const [mode, setMode] = useState<AgentMode>('autonomous');
  const [agenticLoop, setAgenticLoop] = useState(true);
  const [preferProvider, setPreferProvider] = useState<'auto' | 'local-ollama' | 'vllm' | 'gemini'>('auto');
  const [useRepoContext, setUseRepoContext] = useState(true);
  const [useKnowledgeRag, setUseKnowledgeRag] = useState(true);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | undefined>(undefined);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [lastTrace, setLastTrace] = useState<
    Array<{ step?: number; thought?: string; tool: string; ok?: boolean; summary: string; approvalId?: string }>
  >([]);
  const [resolvedApprovals, setResolvedApprovals] = useState<Record<string, string>>({});

  const loadConversations = async () => {
    try {
      const data = await apiClient.request<{ conversations: ConversationSummary[] }>(
        '/api/chat/conversations'
      );
      setConversations(data.conversations);
    } catch {
      // handled silently on first load
    }
  };

  useEffect(() => {
    loadConversations();
  }, []);

  const selectConversation = async (id: string) => {
    setActiveConvId(id);
    setError(null);
    const data = await apiClient.request<{ messages: MessageItem[] }>(
      `/api/chat/conversations/${id}/messages`
    );
    setMessages(data.messages);
  };

  const startNewChat = () => {
    setActiveConvId(undefined);
    setMessages([]);
    setLastTrace([]);
    setError(null);
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || sending) return;

    const userText = prompt.trim();
    setPrompt('');
    setError(null);
    setSending(true);

    const tempUserMsg: MessageItem = {
      id: `temp-${Date.now()}`,
      role: 'user',
      content: userText,
      mode,
    };
    setMessages((prev) => [...prev, tempUserMsg]);

    try {
      const res = await apiClient.request<{
        conversationId: string;
        messageId: string;
        reply: string;
        providerUsed: string;
        modelId: string;
        tokensIn: number;
        tokensOut: number;
        latencyMs: number;
        estimatedCostUsd: number;
        contextFiles: Array<{ path: string; score: number }>;
        citations: Array<{ title: string; collection: string; sourceUrl: string }>;
        toolTrace: Array<{
          step: number;
          thought: string;
          tool: string;
          ok: boolean;
          summary: string;
          approvalId?: string;
        }>;
      }>('/api/chat', {
        method: 'POST',
        body: JSON.stringify({
          conversationId: activeConvId,
          prompt: userText,
          mode,
          agentic: agenticLoop,
          preferProvider,
          useRepoContext,
          useKnowledgeRag,
        }),
      });

      setActiveConvId(res.conversationId);
      setLastTrace(res.toolTrace);
      setMessages((prev) => [
        ...prev,
        {
          id: res.messageId,
          role: 'assistant',
          content: res.reply,
          mode,
          provider_used: `${res.providerUsed} · ${res.modelId}`,
          tokens_in: res.tokensIn,
          tokens_out: res.tokensOut,
          context_files_json: JSON.stringify(res.contextFiles),
          citations_json: JSON.stringify(res.citations),
          feedback_rating: null,
          captured_to_dataset: 0,
        },
      ]);
      await loadConversations();
      onBudgetChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run Codiz agent');
    } finally {
      setSending(false);
    }
  };

  const submitFeedback = async (messageId: string, rating: 1 | -1) => {
    try {
      const res = await apiClient.request<{ ok: boolean; capturedExampleId: string | null }>(
        '/api/chat/feedback',
        {
          method: 'POST',
          body: JSON.stringify({ messageId, rating, captureToDataset: rating === 1 }),
        }
      );
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                feedback_rating: rating,
                captured_to_dataset: res.capturedExampleId ? 1 : m.captured_to_dataset,
              }
            : m
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Feedback submission failed');
    }
  };

  const copyContent = async (id: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 h-full">
      {/* Sessions Sidebar */}
      <aside className="lg:col-span-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 flex flex-col max-h-[calc(100vh-140px)]">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Sessions</h2>
          <button
            onClick={startNewChat}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white transition-colors whitespace-nowrap shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            New Task
          </button>
        </div>

        <div className="flex-1 overflow-y-auto space-y-1.5">
          {conversations.length === 0 ? (
            <p className="text-xs text-slate-500 dark:text-slate-400 py-6 text-center">
              No coding sessions yet. Start a task on the right.
            </p>
          ) : (
            conversations.map((c) => (
              <button
                key={c.id}
                onClick={() => selectConversation(c.id)}
                className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors ${
                  activeConvId === c.id
                    ? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100'
                    : 'hover:bg-slate-50 dark:hover:bg-slate-800/50 text-slate-700 dark:text-slate-300'
                }`}
              >
                <div className="text-xs font-medium truncate">{c.title}</div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 flex items-center gap-1.5">
                  <span>{c.mode}</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono">{c.updated_at.slice(5, 16).replace('T', ' ')}</span>
                </div>
              </button>
            ))
          )}
        </div>

        {/* Agent Configuration Controls */}
        <div className="pt-4 mt-4 border-t border-slate-200 dark:border-slate-800 space-y-3">
          <div>
            <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
              Inference Route
            </label>
            <select
              value={preferProvider}
              onChange={(e) => setPreferProvider(e.target.value as any)}
              className="w-full px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100"
            >
              <option value="auto">Auto ($0 Local First)</option>
              <option value="local-ollama">Local Ollama (Q4_K_M)</option>
              <option value="vllm">Cloud Run vLLM</option>
              <option value="gemini">Server Gemini (Teacher)</option>
            </select>
          </div>

          <label className="flex items-center justify-between text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
            <span>Agentic Tool Loop (Multi-Step)</span>
            <input
              type="checkbox"
              checked={agenticLoop}
              onChange={(e) => setAgenticLoop(e.target.checked)}
              className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
            />
          </label>

          <label className="flex items-center justify-between text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
            <span>Compress Repo Context</span>
            <input
              type="checkbox"
              checked={useRepoContext}
              onChange={(e) => setUseRepoContext(e.target.checked)}
              className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
            />
          </label>

          <label className="flex items-center justify-between text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
            <span>Documentation RAG</span>
            <input
              type="checkbox"
              checked={useKnowledgeRag}
              onChange={(e) => setUseKnowledgeRag(e.target.checked)}
              className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
            />
          </label>
        </div>
      </aside>

      {/* Main Agent Conversation Area */}
      <section className="lg:col-span-9 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl flex flex-col max-h-[calc(100vh-140px)]">
        {/* Segmented Mode Bar */}
        <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-950 rounded-lg overflow-x-auto">
            {MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => setMode(m.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  mode === m.id
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-sm'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          <div className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
            Target budget: {formatCurrency(20, currency, rates)}/mo max
          </div>
        </div>

        {/* Message Stream */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {messages.length === 0 ? (
            <div className="py-12 max-w-2xl mx-auto">
              <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-2">
                Codiz Engineering Workbench
              </h3>
              <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed mb-6">
                Ask Codiz to build, debug, review, or architect software across Cloudflare Workers/Hono,
                Google Cloud Run, Meta WhatsApp webhooks, Flutter offline sync, C++, or Python ML pipelines.
                Approved replies feed directly into your LoRA training dataset.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {[
                  'Write a Hono Cloudflare Worker endpoint with D1 parameterized queries and rate limiting.',
                  'Audit our repository structure in src/server/ and suggest low-memory optimizations.',
                  'Implement a timing-safe Meta WhatsApp Cloud API webhook verification handler in TypeScript.',
                  'Design a Flutter offline-first sync queue for intermittent 3G connections.',
                ].map((sample) => (
                  <button
                    key={sample}
                    onClick={() => setPrompt(sample)}
                    className="text-left p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 hover:border-emerald-500/50 text-xs text-slate-700 dark:text-slate-300 transition-colors"
                  >
                    {sample}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((msg) => {
              const ctxFiles = msg.context_files_json
                ? (JSON.parse(msg.context_files_json) as Array<{ path: string }>)
                : [];
              const citations = msg.citations_json
                ? (JSON.parse(msg.citations_json) as Array<{
                    title: string;
                    collection: string;
                    sourceUrl: string;
                  }>)
                : [];

              return (
                <div
                  key={msg.id}
                  className={`rounded-xl p-4 border ${
                    msg.role === 'user'
                      ? 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800 ml-8'
                      : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 mr-4'
                  }`}
                >
                  <div className="flex items-center justify-between gap-4 mb-2">
                    <div className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-2">
                      <span className="font-semibold text-slate-900 dark:text-slate-100">
                        {msg.role === 'user' ? 'You' : 'Codiz'}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{msg.mode}</span>
                      {msg.provider_used && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono">{msg.provider_used}</span>
                        </>
                      )}
                      {typeof msg.tokens_out === 'number' && msg.tokens_out > 0 && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums">
                            {msg.tokens_in ?? 0} in / {msg.tokens_out} out tok
                          </span>
                        </>
                      )}
                    </div>

                    {msg.role === 'assistant' && (
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => copyContent(msg.id, msg.content)}
                          title="Copy response"
                          className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          {copiedId === msg.id ? (
                            <Check className="w-3.5 h-3.5 text-emerald-500" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                        <button
                          onClick={() => submitFeedback(msg.id, 1)}
                          title="Approve & capture into LoRA training dataset"
                          className={`p-1.5 rounded-md transition-colors ${
                            msg.feedback_rating === 1
                              ? 'text-emerald-600 bg-emerald-500/10'
                              : 'text-slate-500 hover:text-emerald-600 hover:bg-slate-100 dark:hover:bg-slate-800'
                          }`}
                        >
                          <ThumbsUp className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => submitFeedback(msg.id, -1)}
                          title="Flag for Teacher correction"
                          className={`p-1.5 rounded-md transition-colors ${
                            msg.feedback_rating === -1
                              ? 'text-red-600 bg-red-500/10'
                              : 'text-slate-500 hover:text-red-600 hover:bg-slate-100 dark:hover:bg-slate-800'
                          }`}
                        >
                          <ThumbsDown className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="text-sm text-slate-800 dark:text-slate-200 whitespace-pre-wrap leading-relaxed font-sans">
                    {msg.content}
                  </div>

                  {msg.role === 'assistant' && (ctxFiles.length > 0 || citations.length > 0 || msg.captured_to_dataset === 1) && (
                    <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800 text-[11px] text-slate-500 dark:text-slate-400 space-y-1">
                      {ctxFiles.length > 0 && (
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <FileCode2 className="w-3.5 h-3.5 shrink-0" />
                          <span>Repo context:</span>
                          <span className="font-mono text-slate-700 dark:text-slate-300">
                            {ctxFiles.map((f) => f.path).join(' · ')}
                          </span>
                        </div>
                      )}
                      {citations.length > 0 && (
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <BookOpen className="w-3.5 h-3.5 shrink-0" />
                          <span>RAG citations:</span>
                          <span className="text-slate-700 dark:text-slate-300">
                            {citations.map((c) => `${c.collection}: ${c.title}`).join(' · ')}
                          </span>
                        </div>
                      )}
                      {msg.captured_to_dataset === 1 && (
                        <div className="text-emerald-600 dark:text-emerald-400 font-medium">
                          Captured & secret-scrubbed for Model Factory LoRA training.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}

          {lastTrace.length > 0 && (
            <div className="rounded-xl p-4 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-2">
              <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                Agentic Execution Trace ({lastTrace.length} steps)
              </div>
              <div className="space-y-1.5 text-[11px] font-mono">
                {lastTrace.map((t, idx) => (
                  <div
                    key={idx}
                    className="flex flex-wrap items-center justify-between gap-2 text-slate-600 dark:text-slate-300"
                  >
                    <div className="min-w-0">
                      <span className="text-emerald-600 dark:text-emerald-400">
                        Step {t.step ?? idx + 1} · {t.tool}
                      </span>
                      {t.thought && <span className="text-slate-500"> — {t.thought}</span>}
                      <div className="text-slate-700 dark:text-slate-300">{t.summary}</div>
                    </div>
                    {t.approvalId && !resolvedApprovals[t.approvalId] && (
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={async () => {
                            await apiClient.request(`/api/repo/approvals/${t.approvalId}`, {
                              method: 'POST',
                              body: JSON.stringify({ decision: 'approve' }),
                            });
                            setResolvedApprovals((prev) => ({
                              ...prev,
                              [t.approvalId!]: 'approved',
                            }));
                          }}
                          className="px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-700 text-white"
                        >
                          Approve Write
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            await apiClient.request(`/api/repo/approvals/${t.approvalId}`, {
                              method: 'POST',
                              body: JSON.stringify({ decision: 'reject' }),
                            });
                            setResolvedApprovals((prev) => ({
                              ...prev,
                              [t.approvalId!]: 'rejected',
                            }));
                          }}
                          className="px-2.5 py-1 rounded border border-slate-300 dark:border-slate-700"
                        >
                          Reject
                        </button>
                      </div>
                    )}
                    {t.approvalId && resolvedApprovals[t.approvalId] && (
                      <span className="text-emerald-600 dark:text-emerald-400 capitalize">
                        {resolvedApprovals[t.approvalId]}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-600 dark:text-red-400">
              {error}
            </div>
          )}
        </div>

        {/* Prompt Input */}
        <form
          onSubmit={handleSend}
          className="p-4 border-t border-slate-200 dark:border-slate-800 flex items-end gap-3"
        >
          <textarea
            rows={2}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend(e);
              }
            }}
            placeholder={`Ask Codiz (${mode} mode) — Shift+Enter for newline`}
            className="flex-1 px-3.5 py-2.5 text-sm bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-none"
          />
          <button
            type="submit"
            disabled={sending || !prompt.trim()}
            className="px-4 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-sm font-medium inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
          >
            <Send className="w-4 h-4" />
            {sending ? 'Running...' : 'Run Task'}
          </button>
        </form>
      </section>
    </div>
  );
};
