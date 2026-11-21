import crypto from 'node:crypto';
import net from 'node:net';
import { getDb } from '../../db/sqlite.ts';
import { BUCKET_PREFIXES, artifactStorage } from '../../providers/storage/gcs.ts';

export const KNOWLEDGE_COLLECTIONS = [
  'cloudflare',
  'google-cloud',
  'azure',
  'meta',
  'hono',
  'typescript',
  'javascript',
  'react',
  'react-native',
  'vue',
  'nuxt',
  'next-js',
  'flutter',
  'dart',
  'nativescript',
  'docker',
  'npm',
  'github',
  'networking',
  'software-engineering',
] as const;

export type KnowledgeCollection = (typeof KNOWLEDGE_COLLECTIONS)[number];

export interface KnowledgeSearchHit {
  chunkId: string;
  documentId: string;
  collection: string;
  title: string;
  sourceUrl: string;
  content: string;
  codeBlocks: string[];
  score: number;
}

function isPrivateOrBlockedHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (
    lower === 'localhost' ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal') ||
    lower === 'metadata.google.internal'
  ) {
    return true;
  }

  const ipType = net.isIP(lower);
  if (ipType === 4) {
    const parts = lower.split('.').map(Number);
    if (parts[0] === 127) return true;
    if (parts[0] === 10) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 0) return true;
  }
  if (ipType === 6) {
    if (lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')) {
      return true;
    }
  }
  return false;
}

export function validateSafeExternalUrl(rawUrl: string): URL {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Only http/https documentation URLs are permitted.');
  }
  if (isPrivateOrBlockedHost(parsed.hostname)) {
    throw new Error('Blocked private, loopback, or cloud metadata host.');
  }
  return parsed;
}

export function extractMarkdownAndCode(raw: string, contentType = 'text/markdown'): {
  cleanText: string;
  codeBlocks: string[];
} {
  let text = raw;
  if (contentType.includes('html') || raw.trim().startsWith('<')) {
    text = raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n```\n$1\n```\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/\s+\n/g, '\n');
  }

  const codeBlocks: string[] = [];
  const codeRegex = /```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = codeRegex.exec(text)) !== null) {
    const block = match[1].trim();
    if (block.length > 10) codeBlocks.push(block);
  }

  const cleanText = text.replace(/\n{3,}/g, '\n\n').trim();
  return { cleanText, codeBlocks };
}

function chunkText(text: string, maxChars = 1100): string[] {
  if (text.length <= maxChars) return [text];
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    if ((current + '\n\n' + para).length > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

export async function ingestDocumentContent(params: {
  collection: KnowledgeCollection;
  title: string;
  sourceUrl: string;
  docVersion?: string;
  rawContent: string;
  contentType?: string;
}): Promise<{ documentId: string; chunkCount: number; deduplicated: boolean; gcsUri: string }> {
  const db = getDb();
  const { cleanText, codeBlocks } = extractMarkdownAndCode(params.rawContent, params.contentType);
  const contentHash = crypto.createHash('sha256').update(cleanText).digest('hex');

  const existing = db
    .prepare('SELECT id, chunk_count, raw_gcs_uri FROM knowledge_documents WHERE content_hash = ?')
    .get(contentHash) as { id: string; chunk_count: number; raw_gcs_uri: string } | undefined;

  if (existing) {
    return {
      documentId: existing.id,
      chunkCount: existing.chunk_count,
      deduplicated: true,
      gcsUri: existing.raw_gcs_uri,
    };
  }

  const docId = `kdoc-${crypto.randomUUID().slice(0, 10)}`;
  const stored = await artifactStorage.putObject(
    `${BUCKET_PREFIXES.knowledge}/${params.collection}/${docId}.md`,
    cleanText,
    { title: params.title, sourceUrl: params.sourceUrl, collection: params.collection }
  );

  const chunks = chunkText(cleanText);
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO knowledge_documents (
      id, collection, title, source_url, doc_version, content_hash, raw_gcs_uri, chunk_count, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    docId,
    params.collection,
    params.title,
    params.sourceUrl,
    params.docVersion ?? 'latest',
    contentHash,
    stored.uri,
    chunks.length,
    now
  );

  const insertChunk = db.prepare(
    `INSERT INTO knowledge_chunks (
      id, document_id, collection, title, source_url, chunk_index, content, code_blocks_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  chunks.forEach((chunk, idx) => {
    insertChunk.run(
      `kchunk-${crypto.randomUUID().slice(0, 10)}`,
      docId,
      params.collection,
      params.title,
      params.sourceUrl,
      idx,
      chunk,
      JSON.stringify(idx === 0 ? codeBlocks : []),
      now
    );
  });

  return {
    documentId: docId,
    chunkCount: chunks.length,
    deduplicated: false,
    gcsUri: stored.uri,
  };
}

export async function scrapeAndIngestUrl(params: {
  url: string;
  collection: KnowledgeCollection;
  title?: string;
}): Promise<{ documentId: string; chunkCount: number; deduplicated: boolean; gcsUri: string }> {
  const safeUrl = validateSafeExternalUrl(params.url);

  // Polite robots.txt check
  try {
    const robotsUrl = `${safeUrl.origin}/robots.txt`;
    const rCtrl = new AbortController();
    const t = setTimeout(() => rCtrl.abort(), 3000);
    const robotsRes = await fetch(robotsUrl, {
      signal: rCtrl.signal,
      headers: { 'User-Agent': 'CodizKnowledgeBot/1.0 (+personal-coding-assistant)' },
    });
    clearTimeout(t);
    if (robotsRes.ok) {
      const robotsTxt = await robotsRes.text();
      if (/User-agent:\s*\*\s*[\r\n]+Disallow:\s*\/\s*$/im.test(robotsTxt)) {
        throw new Error(`Target ${safeUrl.origin} disallows automated crawling in robots.txt.`);
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('robots.txt')) throw err;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(safeUrl.toString(), {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'CodizKnowledgeBot/1.0 (+personal-coding-assistant)' },
    });
    if (!res.ok) {
      throw new Error(`Documentation fetch returned HTTP ${res.status}`);
    }
    const contentType = res.headers.get('content-type') ?? 'text/plain';
    const body = await res.text();
    const title = params.title?.trim() || safeUrl.hostname + safeUrl.pathname;

    return ingestDocumentContent({
      collection: params.collection,
      title,
      sourceUrl: safeUrl.toString(),
      rawContent: body.slice(0, 200_000),
      contentType,
    });
  } finally {
    clearTimeout(timer);
  }
}

export function searchKnowledge(
  query: string,
  collection?: string,
  limit = 5
): KnowledgeSearchHit[] {
  const db = getDb();
  const rows = (
    collection && collection !== 'all'
      ? db
          .prepare(
            `SELECT id, document_id, collection, title, source_url, content, code_blocks_json
             FROM knowledge_chunks WHERE collection = ?`
          )
          .all(collection)
      : db
          .prepare(
            `SELECT id, document_id, collection, title, source_url, content, code_blocks_json
             FROM knowledge_chunks`
          )
          .all()
  ) as Array<{
    id: string;
    document_id: string;
    collection: string;
    title: string;
    source_url: string;
    content: string;
    code_blocks_json: string;
  }>;

  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 2);

  const scored: KnowledgeSearchHit[] = rows.map((row) => {
    const haystack = `${row.title} ${row.collection} ${row.content}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (row.title.toLowerCase().includes(term)) score += 6;
      if (row.collection.toLowerCase().includes(term)) score += 5;
      const occurrences = haystack.split(term).length - 1;
      score += Math.min(occurrences, 5) * 2;
    }
    return {
      chunkId: row.id,
      documentId: row.document_id,
      collection: row.collection,
      title: row.title,
      sourceUrl: row.source_url,
      content: row.content,
      codeBlocks: JSON.parse(row.code_blocks_json || '[]') as string[],
      score,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.filter((s) => s.score > 0 || terms.length === 0).slice(0, limit);
}

export function listKnowledgeDocuments() {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, collection, title, source_url, doc_version, raw_gcs_uri, chunk_count, created_at
       FROM knowledge_documents ORDER BY created_at DESC`
    )
    .all();
}
