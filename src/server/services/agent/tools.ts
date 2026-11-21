import fs from 'node:fs';
import { z } from 'zod';
import { getDb } from '../../db/sqlite.ts';
import { evaluateCodeSnippet } from '../evaluator/runner.ts';
import {
  indexWorkspaceRepository,
  resolveSafeWorkspacePath,
  selectCompressedContext,
} from '../repository/indexer.ts';
import { searchKnowledge } from '../retrieval/knowledge.ts';

export type ToolRiskLevel = 'read' | 'write' | 'destructive';

export interface RegisteredTool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  riskLevel: ToolRiskLevel;
  requiresApproval: boolean;
  inputSchema: z.ZodType<TInput>;
  execute: (input: TInput) => Promise<TOutput>;
}

const ReadFileSchema = z.object({
  path: z.string().min(1).max(300),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
});

const SearchRepoSchema = z.object({
  query: z.string().min(1).max(200),
  maxFiles: z.number().int().min(1).max(20).default(6),
});

const WriteFileProposalSchema = z.object({
  path: z.string().min(1).max(300),
  content: z.string().max(100_000),
  reason: z.string().min(3).max(500),
});

const SearchDocsSchema = z.object({
  query: z.string().min(1).max(300),
  collection: z.string().optional(),
  limit: z.number().int().min(1).max(10).default(4),
});

const EvaluateCodeSchema = z.object({
  code: z.string().min(1).max(24000),
  language: z.enum(['typescript', 'python', 'other']).default('typescript'),
});

const ProposeCommandSchema = z.object({
  command: z.string().min(1).max(400),
  reason: z.string().min(3).max(400),
});

const BLOCKED_COMMAND_PATTERNS: RegExp[] = [
  /\brm\s+-rf\s+\/(?:\s|$)/i,
  /\b(?:mkfs|fdisk|diskpart|format\s+[a-z]:|shutdown|reboot)\b/i,
  /(?:curl|wget|iwr|irm)\b[^|]*\|\s*(?:sh|bash|pwsh|powershell|iex)/i,
  /\b(?:del|rmdir)\s+\/s\s+\/q\s+[a-z]:\\/i,
];

export function validateProposedShellCommand(cmd: string): void {
  const trimmed = cmd.trim();
  if (!trimmed) throw new Error('Command cannot be empty.');
  for (const pat of BLOCKED_COMMAND_PATTERNS) {
    if (pat.test(trimmed)) {
      throw new Error('Blocked unsafe shell command pattern.');
    }
  }
}

export const TOOL_REGISTRY: Record<string, RegisteredTool<any, any>> = {
  repo_index: {
    name: 'repo_index',
    description: 'List project files, detected languages, and exported symbols across the repository.',
    riskLevel: 'read',
    requiresApproval: false,
    inputSchema: z.object({}),
    execute: async () => {
      const snap = indexWorkspaceRepository();
      return {
        rootName: snap.rootName,
        totalFiles: snap.totalFiles,
        totalLines: snap.totalLines,
        languages: snap.languages,
        files: snap.files.slice(0, 60).map((f) => ({
          path: f.relativePath,
          language: f.language,
          lines: f.lineCount,
          symbols: f.symbols.slice(0, 8),
        })),
      };
    },
  },

  read_file: {
    name: 'read_file',
    description: 'Read a file safely inside the sandboxed workspace directory.',
    riskLevel: 'read',
    requiresApproval: false,
    inputSchema: ReadFileSchema,
    execute: async (input: z.infer<typeof ReadFileSchema>) => {
      const resolved = resolveSafeWorkspacePath(input.path);
      if (!fs.existsSync(resolved)) {
        return { error: `File not found: ${input.path}` };
      }
      const raw = fs.readFileSync(resolved, 'utf8');
      const lines = raw.split('\n');
      const start = Math.max(1, input.startLine ?? 1);
      const end = Math.min(lines.length, input.endLine ?? Math.min(lines.length, start + 199));
      return {
        path: input.path,
        totalLines: lines.length,
        range: `${start}-${end}`,
        content: lines.slice(start - 1, end).join('\n'),
      };
    },
  },

  search_repo_context: {
    name: 'search_repo_context',
    description: 'Retrieve and compress the most relevant project files for a technical query.',
    riskLevel: 'read',
    requiresApproval: false,
    inputSchema: SearchRepoSchema,
    execute: async (input: z.infer<typeof SearchRepoSchema>) => {
      return selectCompressedContext({ query: input.query, maxTokenBudget: 1800 });
    },
  },

  search_documentation: {
    name: 'search_documentation',
    description: 'Search Codiz offline/hybrid technical documentation collections.',
    riskLevel: 'read',
    requiresApproval: false,
    inputSchema: SearchDocsSchema,
    execute: async (input: z.infer<typeof SearchDocsSchema>) => {
      return searchKnowledge(input.query, input.collection, input.limit);
    },
  },

  evaluate_code: {
    name: 'evaluate_code',
    description: 'Run static TypeScript syntax check and security smell scanner on a code snippet.',
    riskLevel: 'read',
    requiresApproval: false,
    inputSchema: EvaluateCodeSchema,
    execute: async (input: z.infer<typeof EvaluateCodeSchema>) => {
      return evaluateCodeSnippet(input.code, input.language);
    },
  },

  propose_file_write: {
    name: 'propose_file_write',
    description:
      'Queue a sandboxed file creation or modification for explicit human approval before writing.',
    riskLevel: 'write',
    requiresApproval: true,
    inputSchema: WriteFileProposalSchema,
    execute: async (input: z.infer<typeof WriteFileProposalSchema>) => {
      // Validate path confinement immediately
      resolveSafeWorkspacePath(input.path);
      const db = getDb();
      const id = `apr-${crypto.randomUUID().slice(0, 10)}`;
      db.prepare(
        `INSERT INTO agent_approvals (id, tool_name, action_summary, payload_json, risk_level, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`
      ).run(
        id,
        'propose_file_write',
        `Write ${input.path}: ${input.reason}`,
        JSON.stringify(input),
        'write',
        new Date().toISOString()
      );
      return {
        approvalId: id,
        status: 'awaiting_human_approval',
        message: `Queued write to ${input.path}. Approve to apply.`,
      };
    },
  },

  propose_command: {
    name: 'propose_command',
    description:
      'Queue a workspace terminal command (e.g. npm test, tsc --noEmit, git status) for explicit human approval before running.',
    riskLevel: 'destructive',
    requiresApproval: true,
    inputSchema: ProposeCommandSchema,
    execute: async (input: z.infer<typeof ProposeCommandSchema>) => {
      validateProposedShellCommand(input.command);
      const db = getDb();
      const id = `apr-${crypto.randomUUID().slice(0, 10)}`;
      db.prepare(
        `INSERT INTO agent_approvals (id, tool_name, action_summary, payload_json, risk_level, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`
      ).run(
        id,
        'propose_command',
        `Run \`${input.command}\`: ${input.reason}`,
        JSON.stringify(input),
        'destructive',
        new Date().toISOString()
      );
      return {
        approvalId: id,
        status: 'awaiting_human_approval',
        message: `Queued command "${input.command}". Approve to execute.`,
      };
    },
  },
};

export async function runRegisteredTool(
  toolName: string,
  rawInput: unknown
): Promise<{ ok: boolean; tool: string; result: unknown }> {
  const tool = TOOL_REGISTRY[toolName];
  if (!tool) {
    return { ok: false, tool: toolName, result: { error: `Unknown tool: ${toolName}` } };
  }
  const parsed = tool.inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      tool: toolName,
      result: { error: 'Tool input validation failed', details: parsed.error.flatten() },
    };
  }
  try {
    const result = await tool.execute(parsed.data);
    return { ok: true, tool: toolName, result };
  } catch (err) {
    return {
      ok: false,
      tool: toolName,
      result: { error: err instanceof Error ? err.message : 'Tool execution error' },
    };
  }
}
