import os from 'node:os';
import { GoogleGenAI } from '@google/genai';
import { getEnv } from '../../config/env.ts';
import { getSelfHostedRuntimeConfig } from '../../config/runtime.ts';
import { recordUsage } from '../../services/budget/tracker.ts';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmCompletionRequest {
  messages: LlmMessage[];
  modelOverride?: string;
  maxTokens?: number;
  jsonMode?: boolean;
  preferProvider?: 'auto' | 'local-ollama' | 'vllm' | 'gemini';
  onToken?: (delta: string) => void;
}

export interface LlmCompletionResult {
  text: string;
  providerUsed: 'local-ollama' | 'vllm' | 'gemini';
  modelId: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  estimatedCostUsd: number;
}

let geminiClient: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI | null {
  const env = getEnv();
  if (!env.GEMINI_API_KEY) return null;
  if (!geminiClient) {
    geminiClient = new GoogleGenAI({
      apiKey: env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return geminiClient;
}

async function callOllamaNativeChat(params: {
  baseUrl: string;
  model: string;
  messages: LlmMessage[];
  maxTokens: number;
  jsonMode?: boolean;
  timeoutMs?: number;
  onToken?: (delta: string) => void;
}): Promise<{ text: string; tokensIn: number; tokensOut: number } | null> {
  const ollamaRoot = params.baseUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
  const controller = new AbortController();
  const timeoutMs = params.timeoutMs ?? 180_000;
  let timer = setTimeout(() => controller.abort(), timeoutMs);
  const resetTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), timeoutMs);
  };

  const logicalCores = Math.max(1, os.cpus().length);
  const numThread = Math.max(2, Math.min(8, Math.floor(logicalCores / 2) || 2));
  const numCtx = logicalCores <= 4 ? 4096 : 8192;
  const shouldStream = Boolean(params.onToken);

  try {
    const res = await fetch(`${ollamaRoot}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: params.model,
        messages: params.messages,
        stream: shouldStream,
        keep_alive: '30m',
        ...(params.jsonMode ? { format: 'json' } : {}),
        options: {
          temperature: 0.2,
          num_predict: params.maxTokens,
          num_thread: numThread,
          num_ctx: numCtx,
        },
      }),
    });

    if (res.status === 404) return null;
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Ollama /api/chat error (${res.status}): ${errText.slice(0, 300)}`);
    }

    if (shouldStream && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';
      let tokensIn = 0;
      let tokensOut = 0;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        resetTimer();
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;
          try {
            const parsed = JSON.parse(line) as {
              message?: { content?: string };
              prompt_eval_count?: number;
              eval_count?: number;
            };
            const delta = parsed.message?.content ?? '';
            if (delta) {
              fullText += delta;
              params.onToken?.(delta);
            }
            if (parsed.prompt_eval_count) tokensIn = parsed.prompt_eval_count;
            if (parsed.eval_count) tokensOut = parsed.eval_count;
          } catch {
            // ignore partial NDJSON lines
          }
        }
      }

      return {
        text: fullText,
        tokensIn: tokensIn || Math.ceil(JSON.stringify(params.messages).length / 4),
        tokensOut: tokensOut || Math.ceil(fullText.length / 4),
      };
    }

    const json = (await res.json()) as {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    const text = json.message?.content ?? '';
    return {
      text,
      tokensIn: json.prompt_eval_count ?? Math.ceil(JSON.stringify(params.messages).length / 4),
      tokensOut: json.eval_count ?? Math.ceil(text.length / 4),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAiCompatible(params: {
  baseUrl: string;
  apiKey?: string;
  model: string;
  messages: LlmMessage[];
  maxTokens: number;
  jsonMode?: boolean;
  timeoutMs?: number;
  onToken?: (delta: string) => void;
}): Promise<{ text: string; tokensIn: number; tokensOut: number }> {
  const controller = new AbortController();
  const timeoutMs = params.timeoutMs ?? 60_000;
  let timer = setTimeout(() => controller.abort(), timeoutMs);
  const resetTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), timeoutMs);
  };

  try {
    const url = `${params.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (params.apiKey) headers['Authorization'] = `Bearer ${params.apiKey}`;
    const shouldStream = Boolean(params.onToken);

    const res = await fetch(url, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: params.model,
        messages: params.messages,
        max_tokens: params.maxTokens,
        temperature: 0.2,
        stream: shouldStream,
        ...(params.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Upstream OpenAI-compatible error (${res.status}): ${errText.slice(0, 300)}`);
    }

    if (shouldStream && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';
      let usageIn = 0;
      let usageOut = 0;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        resetTimer();
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line || !line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const parsed = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
              usage?: { prompt_tokens?: number; completion_tokens?: number };
            };
            const delta =
              parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content ?? '';
            if (delta) {
              fullText += delta;
              params.onToken?.(delta);
            }
            if (parsed.usage?.prompt_tokens) usageIn = parsed.usage.prompt_tokens;
            if (parsed.usage?.completion_tokens) usageOut = parsed.usage.completion_tokens;
          } catch {
            // ignore partial/keepalive SSE chunks
          }
        }
      }

      return {
        text: fullText,
        tokensIn: usageIn || Math.ceil(JSON.stringify(params.messages).length / 4),
        tokensOut: usageOut || Math.ceil(fullText.length / 4),
      };
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const text = json.choices?.[0]?.message?.content ?? '';
    if (text && params.onToken) params.onToken(text);
    return {
      text,
      tokensIn: json.usage?.prompt_tokens ?? Math.ceil(JSON.stringify(params.messages).length / 4),
      tokensOut: json.usage?.completion_tokens ?? Math.ceil(text.length / 4),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeInferenceBackends(): Promise<{
  localOllamaReachable: boolean;
  vllmReachable: boolean;
  geminiConfigured: boolean;
  activeDefault: string;
}> {
  const env = getEnv();
  const runtimeCfg = getSelfHostedRuntimeConfig();

  const checkUrl = async (url: string): Promise<boolean> => {
    if (!url) return false;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1200);
      const res = await fetch(`${url.replace(/\/+$/, '')}/models`, { signal: ctrl.signal });
      clearTimeout(t);
      return res.ok;
    } catch {
      return false;
    }
  };

  const [localOllamaReachable, vllmReachable] = await Promise.all([
    checkUrl(runtimeCfg.selfHostedBaseUrl),
    checkUrl(runtimeCfg.vllmBaseUrl),
  ]);

  const geminiConfigured = Boolean(env.GEMINI_API_KEY);
  let activeDefault = 'unconfigured';
  if (localOllamaReachable) activeDefault = `self-hosted-qwen (${runtimeCfg.selfHostedModel})`;
  else if (vllmReachable) activeDefault = `vllm (${runtimeCfg.vllmModelId})`;
  else if (geminiConfigured) activeDefault = `gemini (${env.TEACHER_MODEL})`;

  return { localOllamaReachable, vllmReachable, geminiConfigured, activeDefault };
}

export async function generateCompletion(
  req: LlmCompletionRequest
): Promise<LlmCompletionResult> {
  const env = getEnv();
  const runtimeCfg = getSelfHostedRuntimeConfig();
  const mode = req.preferProvider ?? runtimeCfg.inferenceMode;
  const maxTokens = Math.min(req.maxTokens ?? 2048, env.MAX_REQUEST_TOKENS);
  const started = Date.now();

  const tryLocal = async (): Promise<LlmCompletionResult | null> => {
    if (!runtimeCfg.selfHostedBaseUrl) return null;
    try {
      const modelId = req.modelOverride || runtimeCfg.selfHostedModel;
      let out: { text: string; tokensIn: number; tokensOut: number } | null = null;
      if (runtimeCfg.selfHostedBaseUrl.includes(':11434')) {
        out = await callOllamaNativeChat({
          baseUrl: runtimeCfg.selfHostedBaseUrl,
          model: modelId,
          messages: req.messages,
          maxTokens,
          jsonMode: req.jsonMode,
          timeoutMs: 180_000,
          onToken: req.onToken,
        });
      }
      if (!out) {
        out = await callOpenAiCompatible({
          baseUrl: runtimeCfg.selfHostedBaseUrl,
          model: modelId,
          messages: req.messages,
          maxTokens,
          jsonMode: req.jsonMode,
          timeoutMs: 180_000,
          onToken: req.onToken,
        });
      }
      const latencyMs = Date.now() - started;
      const commercialEquivalent = ((out.tokensIn + out.tokensOut) / 1_000_000) * 3.0;
      recordUsage({
        category: 'local-inference',
        provider: 'self-hosted-qwen',
        tokensIn: out.tokensIn,
        tokensOut: out.tokensOut,
        estimatedCostUsd: 0,
        localSavedUsd: commercialEquivalent,
        metadata: { modelId },
      });
      return {
        text: out.text,
        providerUsed: 'local-ollama',
        modelId,
        tokensIn: out.tokensIn,
        tokensOut: out.tokensOut,
        latencyMs,
        estimatedCostUsd: 0,
      };
    } catch (err) {
      if (mode === 'local-ollama') throw err;
      return null;
    }
  };

  const tryVllm = async (): Promise<LlmCompletionResult | null> => {
    if (!runtimeCfg.vllmBaseUrl) return null;
    try {
      const modelId = req.modelOverride || runtimeCfg.vllmModelId;
      const out = await callOpenAiCompatible({
        baseUrl: runtimeCfg.vllmBaseUrl,
        apiKey: env.VLLM_API_KEY,
        model: modelId,
        messages: req.messages,
        maxTokens,
        jsonMode: req.jsonMode,
        timeoutMs: 90_000,
        onToken: req.onToken,
      });
      const latencyMs = Date.now() - started;
      const gpuSecCost = (latencyMs / 1000) * (0.68 / 3600);
      recordUsage({
        category: 'cloud-run-gpu',
        provider: 'vllm',
        tokensIn: out.tokensIn,
        tokensOut: out.tokensOut,
        estimatedCostUsd: gpuSecCost,
        metadata: { modelId },
      });
      return {
        text: out.text,
        providerUsed: 'vllm',
        modelId,
        tokensIn: out.tokensIn,
        tokensOut: out.tokensOut,
        latencyMs,
        estimatedCostUsd: gpuSecCost,
      };
    } catch (err) {
      if (mode === 'vllm') throw err;
      return null;
    }
  };

  const tryGemini = async (): Promise<LlmCompletionResult> => {
    const ai = getGeminiClient();
    if (!ai) {
      throw new Error(
        'No inference backend available: start local Ollama (http://127.0.0.1:11434) or set GEMINI_API_KEY in Settings -> Secrets.'
      );
    }

    const systemMsg = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const conversation = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}:\n${m.content}`)
      .join('\n\n');

    const model = env.TEACHER_MODEL || 'gemini-4-hydrogen';
    const response = await ai.models.generateContent({
      model,
      contents: conversation,
      config: {
        ...(systemMsg ? { systemInstruction: systemMsg } : {}),
        ...(req.jsonMode ? { responseMimeType: 'application/json' } : {}),
      },
    });

    const text = response.text ?? '';
    const latencyMs = Date.now() - started;
    const tokensIn =
      response.usageMetadata?.promptTokenCount ?? Math.ceil(conversation.length / 4);
    const tokensOut =
      response.usageMetadata?.candidatesTokenCount ?? Math.ceil(text.length / 4);

    // Track conservative estimated token cost for budget transparency
    const estCost = (tokensIn * 0.0000001) + (tokensOut * 0.0000004);
    recordUsage({
      category: 'teacher-api',
      provider: 'gemini',
      tokensIn,
      tokensOut,
      estimatedCostUsd: estCost,
      metadata: { model },
    });

    return {
      text,
      providerUsed: 'gemini',
      modelId: model,
      tokensIn,
      tokensOut,
      latencyMs,
      estimatedCostUsd: estCost,
    };
  };

  if (mode === 'local-ollama') {
    const localRes = await tryLocal();
    if (!localRes) throw new Error('Local Ollama/llama.cpp server is unreachable.');
    return localRes;
  }

  if (mode === 'vllm') {
    const vllmRes = await tryVllm();
    if (!vllmRes) throw new Error('Cloud Run vLLM endpoint is unreachable.');
    return vllmRes;
  }

  if (mode === 'gemini') {
    return tryGemini();
  }

  // Auto mode: prioritize $0 local quantized runtime -> Cloud Run vLLM -> server Gemini
  const localRes = await tryLocal();
  if (localRes) return localRes;

  const vllmRes = await tryVllm();
  if (vllmRes) return vllmRes;

  return tryGemini();
}
