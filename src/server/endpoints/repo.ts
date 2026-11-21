import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../db/sqlite.ts';
import { TOOL_REGISTRY, runRegisteredTool } from '../services/agent/tools.ts';
import {
  indexWorkspaceRepository,
  invalidateRepoIndexCache,
  resolveSafeWorkspacePath,
  selectCompressedContext,
} from '../services/repository/indexer.ts';

export const repoRouter = new Hono();

const ContextQuerySchema = z.object({
  query: z.string().min(1).max(500),
  explicitFiles: z.array(z.string()).optional(),
  maxTokenBudget: z.number().int().min(300).max(8000).optional(),
});

const ToolRunSchema = z.object({
  toolName: z.string().min(1),
  input: z.unknown().default({}),
});

const ApprovalActionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
});

repoRouter.get('/index', (c) => {
  const snapshot = indexWorkspaceRepository();
  return c.json(snapshot);
});

repoRouter.get('/file', (c) => {
  const relPath = c.req.query('path') ?? '';
  if (!relPath) return c.json({ error: 'Query param ?path= is required' }, 400);
  try {
    const resolved = resolveSafeWorkspacePath(relPath);
    if (!fs.existsSync(resolved)) return c.json({ error: 'File not found' }, 404);
    const content = fs.readFileSync(resolved, 'utf8');
    return c.json({ path: relPath, content });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Access denied' }, 403);
  }
});

repoRouter.post('/context', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = ContextQuerySchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid context request' }, 400);
  return c.json(selectCompressedContext(parsed.data));
});

repoRouter.get('/tools', (c) => {
  const tools = Object.values(TOOL_REGISTRY).map((t) => ({
    name: t.name,
    description: t.description,
    riskLevel: t.riskLevel,
    requiresApproval: t.requiresApproval,
  }));
  return c.json({ tools });
});

repoRouter.post('/tools/run', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = ToolRunSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid tool invocation' }, 400);
  const res = await runRegisteredTool(parsed.data.toolName, parsed.data.input);
  return c.json(res, res.ok ? 200 : 400);
});

repoRouter.get('/approvals', (c) => {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM agent_approvals ORDER BY created_at DESC LIMIT 30')
    .all();
  return c.json({ approvals: rows });
});

repoRouter.post('/approvals/:id', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = ApprovalActionSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid approval decision' }, 400);

  const db = getDb();
  const id = c.req.param('id');
  const row = db.prepare('SELECT * FROM agent_approvals WHERE id = ?').get(id) as
    | Record<string, any>
    | undefined;
  if (!row) return c.json({ error: 'Approval request not found' }, 404);
  if (row.status !== 'pending') return c.json({ error: 'Approval already resolved' }, 409);

  const now = new Date().toISOString();
  if (parsed.data.decision === 'reject') {
    db.prepare(`UPDATE agent_approvals SET status = 'rejected', resolved_at = ? WHERE id = ?`).run(
      now,
      id
    );
    return c.json({ ok: true, status: 'rejected' });
  }

  if (row.tool_name === 'propose_file_write') {
    const payload = JSON.parse(row.payload_json) as { path: string; content: string };
    const safeTarget = resolveSafeWorkspacePath(payload.path);
    fs.mkdirSync(path.dirname(safeTarget), { recursive: true });
    fs.writeFileSync(safeTarget, payload.content, 'utf8');
    invalidateRepoIndexCache();
  }

  db.prepare(`UPDATE agent_approvals SET status = 'approved', resolved_at = ? WHERE id = ?`).run(
    now,
    id
  );
  return c.json({ ok: true, status: 'approved' });
});
