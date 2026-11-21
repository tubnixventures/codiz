import { z } from 'zod';
import { getDb } from '../../db/sqlite.ts';
import { generateCompletion, type LlmMessage } from '../../providers/llm/router.ts';
import type { AgentMode } from '../../types/domain.ts';
import { selectCompressedContext } from '../repository/indexer.ts';
import { searchKnowledge } from '../retrieval/knowledge.ts';
import { TOOL_REGISTRY, runRegisteredTool } from './tools.ts';

const MAX_AGENT_STEPS = 5;

const MODE_INSTRUCTIONS: Record<AgentMode, string> = {
  chat: 'You are Codiz, a practical principal software engineering assistant optimized for low-resource environments, Cloudflare, Google Cloud, Azure, Meta APIs, TypeScript/Hono, Flutter/Dart, C++, and Python.',
  completion:
    'You are Codiz in Code Completion mode. Output concise, type-safe, idiomatic code ready to drop into production with minimal boilerplate.',
  debugging:
    'You are Codiz in Debugging mode. Diagnose root causes systematically, inspect files/types/edge cases using tools when needed, and provide exact minimal fixes.',
  architecture:
    'You are Codiz in Architecture mode. Design modular, low-cost, scale-to-zero systems with clear module boundaries, security guarantees, and cost awareness.',
  review:
    'You are Codiz in Code Review mode. Audit code for security vulnerabilities, memory/CPU overhead, type errors, API misuse, and maintainability.',
  autonomous:
    'You are Codiz in Autonomous Agent mode. Autonomously explore files, consult documentation, validate code with evaluate_code, propose file writes when requested, and report verified findings.',
};

const AgentStepSchema = z.object({
  thought: z.string().default(''),
  action: z.enum(['tool_call', 'final_answer']),
  tool: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  answer: z.string().optional(),
});

export interface AgentTraceStep {
  step: number;
  thought: string;
  tool: string;
  ok: boolean;
  summary: string;
  approvalId?: string;
}

function buildAgenticSystemPrompt(baseSystem: string, compact = false): string {
  const toolCatalog = Object.values(TOOL_REGISTRY)
    .map((t) => `- ${t.name} (${t.riskLevel}): ${t.description}`)
    .join('\n');

  const inputGuide = compact
    ? `Inputs: repo_index={}, read_file={"path","startLine","endLine"}, search_repo_context={"query"}, search_documentation={"query"}, evaluate_code={"code","language"}, propose_file_write={"path","content","reason"}, propose_command={"command","reason"}`
    : `Tool input formats:
- repo_index: {}
- read_file: { "path": "relative/path.ts", "startLine": 1, "endLine": 120 }
- search_repo_context: { "query": "keywords" }
- search_documentation: { "query": "topic", "collection": "cloudflare" }
- evaluate_code: { "code": "...", "language": "typescript" | "python" | "other" }
- propose_file_write: { "path": "relative/path.ts", "content": "...", "reason": "..." }
- propose_command: { "command": "npm test", "reason": "Verify tests pass" }`;

  return `${baseSystem}

You operate in an iterative tool-calling agent loop (max ${MAX_AGENT_STEPS} steps).
Available sandboxed tools:
${toolCatalog}

${inputGuide}

CRITICAL: Respond ONLY with valid JSON matching one of these two shapes:
1) To call a tool:
{"thought":"Why I need this tool","action":"tool_call","tool":"read_file","input":{"path":"src/server/app.ts"}}
2) When ready with your verified final response:
{"thought":"I have verified the solution","action":"final_answer","answer":"Your complete markdown response here"}`;
}

function parseAgentStep(rawText: string): z.infer<typeof AgentStepSchema> | null {
  const trimmed = rawText.trim();
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) candidates.unshift(fenced[1].trim());
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const validated = AgentStepSchema.safeParse(parsed);
      if (validated.success) return validated.data;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function summarizeObservation(tool: string, result: unknown): {
  summary: string;
  approvalId?: string;
  observationText: string;
} {
  const raw = JSON.stringify(result);
  const clipped = raw.length > 2600 ? `${raw.slice(0, 2600)}... [truncated]` : raw;
  let approvalId: string | undefined;
  if (result && typeof result === 'object' && 'approvalId' in result) {
    approvalId = String((result as { approvalId: unknown }).approvalId);
  }
  const summary =
    (tool === 'propose_file_write' || tool === 'propose_command') && approvalId
      ? `Queued ${tool} (${approvalId}) awaiting your approval.`
      : `Executed ${tool} (${raw.length} chars returned).`;

  return { summary, approvalId, observationText: clipped };
}

export async function runAgentTurn(params: {
  conversationId?: string;
  prompt: string;
  mode: AgentMode;
  agentic?: boolean;
  compactMode?: boolean;
  explicitFiles?: string[];
  modelVersionId?: string;
  preferProvider?: 'auto' | 'local-ollama' | 'vllm' | 'gemini';
  useRepoContext?: boolean;
  useKnowledgeRag?: boolean;
  onStepStart?: (step: number, maxSteps: number) => void;
  onToolEvent?: (trace: AgentTraceStep) => void;
  onToken?: (delta: string) => void;
}): Promise<{
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
  toolTrace: AgentTraceStep[];
  pendingApprovalIds: string[];
}> {
  const db = getDb();
  const now = new Date().toISOString();
  const enableAgentLoop =
    params.agentic ?? (params.mode === 'autonomous' || params.mode === 'debugging');
  const compact = params.compactMode ?? false;

  let convId = params.conversationId;
  if (!convId) {
    convId = `conv-${crypto.randomUUID().slice(0, 10)}`;
    const activeProd = db
      .prepare(`SELECT id FROM model_versions WHERE deployment_status = 'production' LIMIT 1`)
      .get() as { id: string } | undefined;
    db.prepare(
      `INSERT INTO conversations (id, title, mode, model_version_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      convId,
      params.prompt.slice(0, 72),
      params.mode,
      params.modelVersionId ?? activeProd?.id ?? 'mv-codiz-base-100',
      now,
      now
    );
  }

  const toolTrace: AgentTraceStep[] = [];
  const pendingApprovalIds: string[] = [];

  // Pre-seed lightweight context & RAG if enabled
  let contextFiles: Array<{ path: string; score: number; excerpt: string }> = [];
  if (params.useRepoContext !== false) {
    const repoCtx = selectCompressedContext({
      query: params.prompt,
      explicitFiles: params.explicitFiles,
      maxTokenBudget: compact ? 750 : 1400,
    });
    contextFiles = repoCtx.selectedFiles;
    const preTrace: AgentTraceStep = {
      step: 0,
      thought: 'Preloading relevant compressed repository context',
      tool: 'search_repo_context',
      ok: true,
      summary: `Compressed ${repoCtx.totalRepoFiles} repo files into ${contextFiles.length} excerpts (~${repoCtx.estimatedTokens} tokens).`,
    };
    toolTrace.push(preTrace);
    params.onToolEvent?.(preTrace);
  }

  let citations: Array<{ title: string; collection: string; sourceUrl: string; snippet: string }> = [];
  if (params.useKnowledgeRag !== false) {
    const hits = searchKnowledge(params.prompt, undefined, compact ? 2 : 3);
    citations = hits.map((h) => ({
      title: h.title,
      collection: h.collection,
      sourceUrl: h.sourceUrl,
      snippet: h.content.slice(0, compact ? 260 : 400),
    }));
    if (citations.length > 0) {
      const ragTrace: AgentTraceStep = {
        step: 0,
        thought: 'Preloading matching official documentation chunks',
        tool: 'search_documentation',
        ok: true,
        summary: `Retrieved ${citations.length} official doc citations.`,
      };
      toolTrace.push(ragTrace);
      params.onToolEvent?.(ragTrace);
    }
  }

  const historyLimit = compact ? 4 : 6;
  const historyRows = db
    .prepare(
      `SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?`
    )
    .all(convId, historyLimit) as Array<{ role: 'user' | 'assistant'; content: string }>;
  historyRows.reverse();

  const systemParts = [
    MODE_INSTRUCTIONS[params.mode],
    'Prioritize memory efficiency, low cloud cost, type safety, and security.',
  ];
  if (contextFiles.length > 0) {
    systemParts.push(
      '--- REPOSITORY CONTEXT (COMPRESSED) ---\n' +
        contextFiles.map((f) => `File: ${f.path}\n\`\`\`\n${f.excerpt}\n\`\`\``).join('\n\n')
    );
  }
  if (citations.length > 0) {
    systemParts.push(
      '--- KNOWLEDGE RAG CITATIONS ---\n' +
        citations
          .map((c) => `[${c.collection}] ${c.title} (${c.sourceUrl}):\n${c.snippet}`)
          .join('\n\n')
    );
  }

  const userMsgId = `msg-${crypto.randomUUID().slice(0, 10)}`;
  db.prepare(
    `INSERT INTO messages (
      id, conversation_id, role, content, mode, provider_used,
      tokens_in, tokens_out, context_files_json, citations_json, created_at
    ) VALUES (?, ?, 'user', ?, ?, 'user', 0, 0, ?, ?, ?)`
  ).run(
    userMsgId,
    convId,
    params.prompt,
    params.mode,
    JSON.stringify(contextFiles.map((c) => ({ path: c.path, score: c.score }))),
    JSON.stringify(citations.map(({ title, collection, sourceUrl }) => ({ title, collection, sourceUrl }))),
    now
  );

  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalLatencyMs = 0;
  let totalCostUsd = 0;
  let lastProvider = 'unknown';
  let lastModelId = 'unknown';
  let finalReply = '';

  if (!enableAgentLoop) {
    params.onStepStart?.(1, 1);
    const completion = await generateCompletion({
      messages: [
        { role: 'system', content: systemParts.join('\n\n') },
        ...historyRows.map((h) => ({
          role: h.role,
          content: compact ? h.content.slice(0, 1200) : h.content,
        })),
        { role: 'user', content: params.prompt },
      ],
      preferProvider: params.preferProvider,
      onToken: params.onToken,
    });
    finalReply = completion.text;
    totalTokensIn = completion.tokensIn;
    totalTokensOut = completion.tokensOut;
    totalLatencyMs = completion.latencyMs;
    totalCostUsd = completion.estimatedCostUsd;
    lastProvider = completion.providerUsed;
    lastModelId = completion.modelId;
  } else {
    // True Multi-Step Bounded ReAct / Tool-Calling Agent Loop
    const scratchpad: LlmMessage[] = [
      { role: 'system', content: buildAgenticSystemPrompt(systemParts.join('\n\n'), compact) },
      ...historyRows.map((h) => ({
        role: h.role,
        content: compact ? h.content.slice(0, 1200) : h.content,
      })),
      { role: 'user', content: params.prompt },
    ];
    const seenToolCalls = new Set<string>();

    for (let step = 1; step <= MAX_AGENT_STEPS; step++) {
      params.onStepStart?.(step, MAX_AGENT_STEPS);
      const completion = await generateCompletion({
        messages: scratchpad,
        jsonMode: true,
        preferProvider: params.preferProvider,
      });

      totalTokensIn += completion.tokensIn;
      totalTokensOut += completion.tokensOut;
      totalLatencyMs += completion.latencyMs;
      totalCostUsd += completion.estimatedCostUsd;
      lastProvider = completion.providerUsed;
      lastModelId = completion.modelId;

      const parsed = parseAgentStep(completion.text);
      if (!parsed) {
        finalReply = completion.text;
        break;
      }

      if (parsed.action === 'final_answer') {
        finalReply = parsed.answer?.trim() || completion.text;
        const doneTrace: AgentTraceStep = {
          step,
          thought: parsed.thought || 'Synthesized final verified response.',
          tool: 'final_answer',
          ok: true,
          summary: 'Completed multi-step agent reasoning.',
        };
        toolTrace.push(doneTrace);
        params.onToolEvent?.(doneTrace);
        break;
      }

      const toolName = parsed.tool ?? '';
      const toolInput = parsed.input ?? {};
      const callSignature = `${toolName}:${JSON.stringify(toolInput)}`;

      if (seenToolCalls.has(callSignature)) {
        scratchpad.push({ role: 'assistant', content: completion.text });
        scratchpad.push({
          role: 'user',
          content: `You already ran ${toolName} with identical arguments. Choose a different tool or emit final_answer now.`,
        });
        continue;
      }
      seenToolCalls.add(callSignature);

      const execResult = await runRegisteredTool(toolName, toolInput);
      const obs = summarizeObservation(toolName, execResult.result);
      if (obs.approvalId) pendingApprovalIds.push(obs.approvalId);

      const stepTrace: AgentTraceStep = {
        step,
        thought: parsed.thought || `Invoke ${toolName}`,
        tool: toolName,
        ok: execResult.ok,
        summary: obs.summary,
        approvalId: obs.approvalId,
      };
      toolTrace.push(stepTrace);
      params.onToolEvent?.(stepTrace);

      scratchpad.push({ role: 'assistant', content: completion.text });
      scratchpad.push({
        role: 'user',
        content: `Tool Observation (${toolName}, ok=${execResult.ok}):\n${obs.observationText}\n\nProceed to the next step or output final_answer.`,
      });

      if (step === MAX_AGENT_STEPS) {
        params.onStepStart?.(MAX_AGENT_STEPS, MAX_AGENT_STEPS);
        const finalPass = await generateCompletion({
          messages: [
            ...scratchpad,
            {
              role: 'user',
              content:
                'Maximum tool steps reached. Output final JSON {"thought":"...","action":"final_answer","answer":"..."} summarizing your verified findings.',
            },
          ],
          jsonMode: true,
          preferProvider: params.preferProvider,
        });
        totalTokensIn += finalPass.tokensIn;
        totalTokensOut += finalPass.tokensOut;
        totalLatencyMs += finalPass.latencyMs;
        totalCostUsd += finalPass.estimatedCostUsd;
        const parsedFinal = parseAgentStep(finalPass.text);
        finalReply = parsedFinal?.answer?.trim() || finalPass.text;
      }
    }
  }

  const assistantMsgId = `msg-${crypto.randomUUID().slice(0, 10)}`;
  const replyTs = new Date().toISOString();

  db.prepare(
    `INSERT INTO messages (
      id, conversation_id, role, content, mode, provider_used,
      tokens_in, tokens_out, context_files_json, citations_json, created_at
    ) VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    assistantMsgId,
    convId,
    finalReply,
    params.mode,
    lastProvider,
    totalTokensIn,
    totalTokensOut,
    JSON.stringify(contextFiles.map((c) => ({ path: c.path, score: c.score }))),
    JSON.stringify(citations.map(({ title, collection, sourceUrl }) => ({ title, collection, sourceUrl }))),
    replyTs
  );

  db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(replyTs, convId);

  return {
    conversationId: convId,
    messageId: assistantMsgId,
    reply: finalReply,
    providerUsed: lastProvider,
    modelId: lastModelId,
    tokensIn: totalTokensIn,
    tokensOut: totalTokensOut,
    latencyMs: totalLatencyMs,
    estimatedCostUsd: totalCostUsd,
    contextFiles: contextFiles.map((c) => ({ path: c.path, score: c.score })),
    citations: citations.map(({ title, collection, sourceUrl }) => ({
      title,
      collection,
      sourceUrl,
    })),
    toolTrace,
    pendingApprovalIds,
  };
}
