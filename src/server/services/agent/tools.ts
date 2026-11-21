import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getEnv } from '../../config/env.ts';
import { getDb } from '../../db/sqlite.ts';
import { evaluateCodeSnippet } from '../evaluator/runner.ts';
import {
  indexWorkspaceRepository,
  invalidateRepoIndexCache,
  resolveSafeWorkspacePath,
  selectCompressedContext,
} from '../repository/indexer.ts';
import { searchKnowledge } from '../retrieval/knowledge.ts';
import { webScrape, webSearch } from '../web/research.ts';

export type ToolRiskLevel = 'read' | 'write' | 'destructive';

export type ConfirmActionRequest =
  | {
      kind: 'file_write';
      path: string;
      oldContent: string | null;
      newContent: string;
      reason: string;
    }
  | {
      kind: 'command';
      command: string;
      cwd: string;
      reason: string;
    };

export interface ToolExecutionContext {
  onConfirmAction?: (req: ConfirmActionRequest) => Promise<boolean>;
}

export interface RegisteredTool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  riskLevel: ToolRiskLevel;
  requiresApproval: boolean;
  inputSchema: z.ZodType<TInput>;
  execute: (input: TInput, ctx?: ToolExecutionContext) => Promise<TOutput>;
}

const ListFilesSchema = z.object({
  dir: z.string().max(300).optional(),
  limit: z.number().int().min(1).max(200).default(80),
});

const GrepSearchSchema = z.object({
  query: z.string().min(1).max(200),
  isRegex: z.boolean().default(false),
  maxMatches: z.number().int().min(1).max(60).default(25),
});

const ReadFileSchema = z.object({
  path: z.string().min(1).max(300),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
});

const SearchRepoSchema = z.object({
  query: z.string().min(1).max(200),
  maxFiles: z.number().int().min(1).max(20).default(6),
});

const WriteFileSchema = z.object({
  path: z.string().min(1).max(300),
  content: z.string().max(150_000),
  reason: z.string().min(2).max(500).default('Create or update file'),
});

const EditFileSchema = z.object({
  path: z.string().min(1).max(300),
  oldText: z.string().min(1).max(40_000),
  newText: z.string().max(40_000),
  reason: z.string().min(2).max(500).default('Targeted file edit'),
});

const SearchDocsSchema = z.object({
  query: z.string().min(1).max(300),
  collection: z.string().optional(),
  limit: z.number().int().min(1).max(10).default(4),
});

const WebSearchSchema = z.object({
  query: z.string().min(1).max(300),
  limit: z.number().int().min(1).max(8).default(5),
});

const WebScrapeSchema = z.object({
  url: z.string().url().max(1000),
  maxChars: z.number().int().min(500).max(12000).default(4200),
});

const EvaluateCodeSchema = z.object({
  code: z.string().min(1).max(24000),
  language: z.enum(['typescript', 'python', 'other']).default('typescript'),
});

const CommandSchema = z.object({
  command: z.string().min(1).max(400),
  reason: z.string().min(2).max(400).default('Run workspace CLI command'),
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

async function applyOrQueueFileWrite(
  relPath: string,
  newContent: string,
  reason: string,
  ctx?: ToolExecutionContext
) {
  const safeTarget = resolveSafeWorkspacePath(relPath);
  const oldContent = fs.existsSync(safeTarget) ? fs.readFileSync(safeTarget, 'utf8') : null;

  if (ctx?.onConfirmAction) {
    const approved = await ctx.onConfirmAction({
      kind: 'file_write',
      path: relPath,
      oldContent,
      newContent,
      reason,
    });
    if (!approved) {
      return {
        status: 'rejected_by_user',
        path: relPath,
        message: `User declined write to ${relPath}.`,
      };
    }
    fs.mkdirSync(path.dirname(safeTarget), { recursive: true });
    fs.writeFileSync(safeTarget, newContent, 'utf8');
    invalidateRepoIndexCache();
    return {
      status: 'applied',
      path: relPath,
      bytesWritten: Buffer.byteLength(newContent, 'utf8'),
      message: `${oldContent === null ? 'Created' : 'Updated'} ${relPath}.`,
    };
  }

  const db = getDb();
  const id = `apr-${crypto.randomUUID().slice(0, 10)}`;
  db.prepare(
    `INSERT INTO agent_approvals (id, tool_name, action_summary, payload_json, risk_level, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`
  ).run(
    id,
    'propose_file_write',
    `Write ${relPath}: ${reason}`,
    JSON.stringify({ path: relPath, content: newContent, reason }),
    'write',
    new Date().toISOString()
  );
  return {
    approvalId: id,
    status: 'awaiting_human_approval',
    message: `Queued write to ${relPath}. Approve to apply.`,
  };
}

async function runOrQueueShellCommand(
  command: string,
  reason: string,
  ctx?: ToolExecutionContext
) {
  validateProposedShellCommand(command);
  const env = getEnv();

  if (ctx?.onConfirmAction) {
    const approved = await ctx.onConfirmAction({
      kind: 'command',
      command,
      cwd: env.CODIZ_WORKSPACE_ROOT,
      reason,
    });
    if (!approved) {
      return {
        status: 'rejected_by_user',
        command,
        message: `User declined running command "${command}".`,
      };
    }

    const started = Date.now();
    const shellBin = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
    const shellArgs = process.platform === 'win32' ? ['/c', command] : ['-c', command];
    const res = spawnSync(shellBin, shellArgs, {
      cwd: env.CODIZ_WORKSPACE_ROOT,
      encoding: 'utf8',
      timeout: 45_000,
      maxBuffer: 1024 * 1024,
    });

    const stdout = (res.stdout ?? '').slice(-2500);
    const stderr = (res.stderr ?? '').slice(-2000);
    invalidateRepoIndexCache();
    return {
      status: 'executed',
      command,
      exitCode: res.status ?? (res.error ? 1 : 0),
      durationMs: Date.now() - started,
      stdout,
      stderr,
      ...(res.error ? { error: res.error.message } : {}),
    };
  }

  const db = getDb();
  const id = `apr-${crypto.randomUUID().slice(0, 10)}`;
  db.prepare(
    `INSERT INTO agent_approvals (id, tool_name, action_summary, payload_json, risk_level, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`
  ).run(
    id,
    'propose_command',
    `Run \`${command}\`: ${reason}`,
    JSON.stringify({ command, reason }),
    'destructive',
    new Date().toISOString()
  );
  return {
    approvalId: id,
    status: 'awaiting_human_approval',
    message: `Queued command "${command}". Approve to execute.`,
  };
}

export const TOOL_REGISTRY: Record<string, RegisteredTool<any, any>> = {
  list_files: {
    name: 'list_files',
    description: 'List project files and directories in the workspace (optionally under a subfolder).',
    riskLevel: 'read',
    requiresApproval: false,
    inputSchema: ListFilesSchema,
    execute: async (input: z.infer<typeof ListFilesSchema>) => {
      const snap = indexWorkspaceRepository();
      const prefix = input.dir ? input.dir.replace(/^\/+|\/+$/g, '') + '/' : '';
      const filtered = prefix
        ? snap.files.filter((f) => f.relativePath.startsWith(prefix))
        : snap.files;
      return {
        workspace: snap.rootName,
        totalMatching: filtered.length,
        files: filtered.slice(0, input.limit).map((f) => ({
          path: f.relativePath,
          language: f.language,
          lines: f.lineCount,
        })),
      };
    },
  },

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

  grep_search: {
    name: 'grep_search',
    description: 'Search for text or regex patterns across workspace source files with file:line hits.',
    riskLevel: 'read',
    requiresApproval: false,
    inputSchema: GrepSearchSchema,
    execute: async (input: z.infer<typeof GrepSearchSchema>) => {
      const snap = indexWorkspaceRepository();
      const matches: Array<{ path: string; line: number; text: string }> = [];
      const regex = input.isRegex ? new RegExp(input.query, 'i') : null;
      const needle = input.query.toLowerCase();

      for (const f of snap.files) {
        if (matches.length >= input.maxMatches) break;
        const resolved = resolveSafeWorkspacePath(f.relativePath);
        let content = '';
        try {
          content = fs.readFileSync(resolved, 'utf8');
        } catch {
          continue;
        }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const hit = regex ? regex.test(line) : line.toLowerCase().includes(needle);
          if (hit) {
            matches.push({ path: f.relativePath, line: i + 1, text: line.trim().slice(0, 180) });
            if (matches.length >= input.maxMatches) break;
          }
        }
      }
      return { query: input.query, matchCount: matches.length, matches };
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
      return selectCompressedContext({ query: input.query, maxTokenBudget: 1600 });
    },
  },

  web_search: {
    name: 'web_search',
    description: 'Search the live web for documentation, npm/PyPI packages, error solutions, and guides.',
    riskLevel: 'read',
    requiresApproval: false,
    inputSchema: WebSearchSchema,
    execute: async (input: z.infer<typeof WebSearchSchema>) => {
      return webSearch(input.query, input.limit);
    },
  },

  web_scrape: {
    name: 'web_scrape',
    description: 'Fetch and extract clean readable text and code blocks from a public documentation/web URL.',
    riskLevel: 'read',
    requiresApproval: false,
    inputSchema: WebScrapeSchema,
    execute: async (input: z.infer<typeof WebScrapeSchema>) => {
      return webScrape(input.url, input.maxChars);
    },
  },

  search_documentation: {
    name: 'search_documentation',
    description: 'Search Codiz local offline technical documentation cache.',
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

  write_file: {
    name: 'write_file',
    description: 'Create a new file or overwrite a file in the workspace (with user confirmation).',
    riskLevel: 'write',
    requiresApproval: true,
    inputSchema: WriteFileSchema,
    execute: async (input: z.infer<typeof WriteFileSchema>, ctx?: ToolExecutionContext) => {
      return applyOrQueueFileWrite(input.path, input.content, input.reason, ctx);
    },
  },

  edit_file: {
    name: 'edit_file',
    description: 'Replace an exact text block in an existing workspace file (faster and safer than full overwrite).',
    riskLevel: 'write',
    requiresApproval: true,
    inputSchema: EditFileSchema,
    execute: async (input: z.infer<typeof EditFileSchema>, ctx?: ToolExecutionContext) => {
      const safeTarget = resolveSafeWorkspacePath(input.path);
      if (!fs.existsSync(safeTarget)) {
        return { error: `File not found: ${input.path}` };
      }
      const current = fs.readFileSync(safeTarget, 'utf8');
      if (!current.includes(input.oldText)) {
        return {
          error: `oldText not found verbatim in ${input.path}. Read the file first to copy exact lines.`,
        };
      }
      const next = current.replace(input.oldText, input.newText);
      return applyOrQueueFileWrite(input.path, next, input.reason, ctx);
    },
  },

  run_command: {
    name: 'run_command',
    description:
      'Execute a workspace shell command (e.g. npm install, npm test, tsc --noEmit, python script.py, git status) and return stdout/stderr.',
    riskLevel: 'destructive',
    requiresApproval: true,
    inputSchema: CommandSchema,
    execute: async (input: z.infer<typeof CommandSchema>, ctx?: ToolExecutionContext) => {
      return runOrQueueShellCommand(input.command, input.reason, ctx);
    },
  },

  propose_file_write: {
    name: 'propose_file_write',
    description:
      'Create or update a file inside the sandboxed workspace (alias of write_file).',
    riskLevel: 'write',
    requiresApproval: true,
    inputSchema: WriteFileSchema,
    execute: async (input: z.infer<typeof WriteFileSchema>, ctx?: ToolExecutionContext) => {
      return applyOrQueueFileWrite(input.path, input.content, input.reason, ctx);
    },
  },

  propose_command: {
    name: 'propose_command',
    description:
      'Execute a workspace terminal command (alias of run_command).',
    riskLevel: 'destructive',
    requiresApproval: true,
    inputSchema: CommandSchema,
    execute: async (input: z.infer<typeof CommandSchema>, ctx?: ToolExecutionContext) => {
      return runOrQueueShellCommand(input.command, input.reason, ctx);
    },
  },
};

export async function runRegisteredTool(
  toolName: string,
  rawInput: unknown,
  ctx?: ToolExecutionContext
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
    const result = await tool.execute(parsed.data, ctx);
    const hasError =
      result && typeof result === 'object' && 'error' in result && Boolean((result as { error?: unknown }).error);
    return { ok: !hasError, tool: toolName, result };
  } catch (err) {
    return {
      ok: false,
      tool: toolName,
      result: { error: err instanceof Error ? err.message : 'Tool execution error' },
    };
  }
}
