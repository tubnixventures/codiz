import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../db/sqlite.ts';
import { runAgentTurn } from '../services/agent/orchestrator.ts';
import { ingestTrainingExample } from '../services/teacher/factory.ts';

export const chatRouter = new Hono();

const ChatRequestSchema = z.object({
  conversationId: z.string().optional(),
  prompt: z.string().min(1).max(24000),
  mode: z
    .enum(['chat', 'completion', 'debugging', 'architecture', 'review', 'autonomous'])
    .default('chat'),
  agentic: z.boolean().optional(),
  explicitFiles: z.array(z.string()).max(12).optional(),
  modelVersionId: z.string().optional(),
  preferProvider: z.enum(['auto', 'local-ollama', 'vllm', 'gemini']).optional(),
  useRepoContext: z.boolean().optional().default(true),
  useKnowledgeRag: z.boolean().optional().default(true),
});

const FeedbackSchema = z.object({
  messageId: z.string().min(1),
  rating: z.union([z.literal(1), z.literal(-1)]),
  captureToDataset: z.boolean().default(true),
});

chatRouter.post('/', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = ChatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid chat request', details: parsed.error.flatten() }, 400);
  }

  try {
    const result = await runAgentTurn(parsed.data);
    return c.json(result);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : 'Agent execution failed' },
      502
    );
  }
});

chatRouter.get('/conversations', (c) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, title, mode, model_version_id, created_at, updated_at
       FROM conversations ORDER BY updated_at DESC LIMIT 30`
    )
    .all();
  return c.json({ conversations: rows });
});

chatRouter.get('/conversations/:id/messages', (c) => {
  const db = getDb();
  const id = c.req.param('id');
  const rows = db
    .prepare(
      `SELECT id, role, content, mode, provider_used, tokens_in, tokens_out,
              context_files_json, citations_json, feedback_rating, captured_to_dataset, created_at
       FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`
    )
    .all(id);
  return c.json({ messages: rows });
});

chatRouter.post('/feedback', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = FeedbackSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid feedback payload' }, 400);
  }

  const db = getDb();
  const msg = db
    .prepare('SELECT id, conversation_id, content, created_at FROM messages WHERE id = ?')
    .get(parsed.data.messageId) as
    | { id: string; conversation_id: string; content: string; created_at: string }
    | undefined;

  if (!msg) return c.json({ error: 'Message not found' }, 404);

  db.prepare('UPDATE messages SET feedback_rating = ? WHERE id = ?').run(
    parsed.data.rating,
    msg.id
  );

  let capturedExampleId: string | null = null;
  if (parsed.data.rating === 1 && parsed.data.captureToDataset) {
    const prevUser = db
      .prepare(
        `SELECT content FROM messages
         WHERE conversation_id = ? AND role = 'user' AND created_at <= ?
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(msg.conversation_id, msg.created_at) as { content: string } | undefined;

    if (prevUser) {
      try {
        const ingested = ingestTrainingExample({
          prompt: prevUser.content,
          completion: msg.content,
          source: 'interaction',
          attribution: 'Codiz Verified User Interaction',
        });
        capturedExampleId = ingested.record.id;
        db.prepare('UPDATE messages SET captured_to_dataset = 1 WHERE id = ?').run(msg.id);
      } catch {
        // Ignore short conversational replies that don't meet training length gate
      }
    }
  }

  return c.json({ ok: true, capturedExampleId });
});
