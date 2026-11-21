import { Hono } from 'hono';
import { z } from 'zod';
import {
  KNOWLEDGE_COLLECTIONS,
  ingestDocumentContent,
  listKnowledgeDocuments,
  scrapeAndIngestUrl,
  searchKnowledge,
} from '../services/retrieval/knowledge.ts';

export const knowledgeRouter = new Hono();

const IngestSchema = z.object({
  collection: z.enum(KNOWLEDGE_COLLECTIONS),
  title: z.string().min(3).max(200),
  sourceUrl: z.string().url().default('https://docs.local.codiz/manual'),
  docVersion: z.string().max(40).optional(),
  rawContent: z.string().min(20).max(200_000),
});

const ScrapeSchema = z.object({
  collection: z.enum(KNOWLEDGE_COLLECTIONS),
  url: z.string().url(),
  title: z.string().max(200).optional(),
});

knowledgeRouter.get('/collections', (c) => {
  return c.json({ collections: KNOWLEDGE_COLLECTIONS });
});

knowledgeRouter.get('/documents', (c) => {
  return c.json({ documents: listKnowledgeDocuments() });
});

knowledgeRouter.get('/search', (c) => {
  const q = c.req.query('q') ?? '';
  const collection = c.req.query('collection');
  const limit = Math.min(20, Math.max(1, Number(c.req.query('limit') ?? 6)));
  if (!q.trim()) {
    return c.json({ hits: [] });
  }
  return c.json({ hits: searchKnowledge(q, collection, limit) });
});

knowledgeRouter.post('/ingest', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = IngestSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid document payload' }, 400);
  const res = await ingestDocumentContent(parsed.data);
  return c.json(res, 201);
});

knowledgeRouter.post('/scrape', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = ScrapeSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid URL scrape payload' }, 400);
  try {
    const res = await scrapeAndIngestUrl(parsed.data);
    return c.json(res, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Scrape blocked' }, 400);
  }
});
