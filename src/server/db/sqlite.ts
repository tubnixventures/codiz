import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getEnv } from '../config/env.ts';

let dbInstance: Database.Database | null = null;
let dbInstancePath: string | null = null;

export function getDb(customDbPath?: string): Database.Database {
  const env = getEnv();
  const dbPath = customDbPath ?? path.join(env.CODIZ_DATA_DIR, 'codiz.db');

  if (dbInstance && !customDbPath && dbInstancePath === dbPath) {
    return dbInstance;
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -8000');
  db.pragma('temp_store = MEMORY');
  db.pragma('foreign_keys = ON');

  runMigrations(db);
  seedInitialData(db);

  if (!customDbPath) {
    if (dbInstance && dbInstancePath !== dbPath) {
      dbInstance.close();
    }
    dbInstance = db;
    dbInstancePath = dbPath;
  }
  return db;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    dbInstancePath = null;
  }
}

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      passphrase_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      claimed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS model_versions (
      id TEXT PRIMARY KEY,
      version_tag TEXT NOT NULL UNIQUE,
      foundation_model_id TEXT NOT NULL,
      foundation_model_name TEXT NOT NULL,
      adapter_version TEXT NOT NULL,
      adapter_uri TEXT NOT NULL,
      dataset_version TEXT NOT NULL,
      lora_config_json TEXT NOT NULL,
      training_date TEXT NOT NULL,
      validation_loss REAL,
      eval_metrics_json TEXT,
      approval_status TEXT NOT NULL DEFAULT 'pending',
      deployment_status TEXT NOT NULL DEFAULT 'draft',
      previous_production_id TEXT,
      sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      mode TEXT NOT NULL,
      model_version_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      mode TEXT NOT NULL,
      provider_used TEXT NOT NULL,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      context_files_json TEXT NOT NULL DEFAULT '[]',
      citations_json TEXT NOT NULL DEFAULT '[]',
      feedback_rating INTEGER,
      captured_to_dataset INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS training_examples (
      id TEXT PRIMARY KEY,
      dataset_version TEXT NOT NULL,
      stage TEXT NOT NULL,
      category TEXT NOT NULL,
      difficulty TEXT NOT NULL,
      source TEXT NOT NULL,
      license_metadata TEXT NOT NULL,
      attribution TEXT NOT NULL,
      prompt TEXT NOT NULL,
      completion TEXT NOT NULL,
      system_context TEXT NOT NULL DEFAULT '',
      secrets_scrubbed INTEGER NOT NULL DEFAULT 1,
      teacher_score REAL,
      automated_checks_passed INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS training_runs (
      id TEXT PRIMARY KEY,
      dataset_version TEXT NOT NULL,
      foundation_model_id TEXT NOT NULL,
      adapter_version TEXT NOT NULL,
      lora_config_json TEXT NOT NULL,
      status TEXT NOT NULL,
      examples_count INTEGER NOT NULL,
      estimated_cost_usd REAL NOT NULL,
      actual_cost_usd REAL NOT NULL DEFAULT 0,
      validation_loss REAL,
      logs TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS evaluations (
      id TEXT PRIMARY KEY,
      model_version_id TEXT NOT NULL,
      overall_score REAL NOT NULL,
      typecheck_pass_rate REAL NOT NULL,
      security_pass_rate REAL NOT NULL,
      unit_test_pass_rate REAL NOT NULL,
      api_accuracy_score REAL NOT NULL,
      avg_latency_ms REAL NOT NULL,
      checks_run INTEGER NOT NULL,
      passed_promotion_gate INTEGER NOT NULL,
      report_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS knowledge_documents (
      id TEXT PRIMARY KEY,
      collection TEXT NOT NULL,
      title TEXT NOT NULL,
      source_url TEXT NOT NULL,
      doc_version TEXT NOT NULL,
      content_hash TEXT NOT NULL UNIQUE,
      raw_gcs_uri TEXT NOT NULL,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      collection TEXT NOT NULL,
      title TEXT NOT NULL,
      source_url TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      code_blocks_json TEXT NOT NULL DEFAULT '[]',
      embedding_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (document_id) REFERENCES knowledge_documents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS usage_ledger (
      id TEXT PRIMARY KEY,
      month_key TEXT NOT NULL,
      day_key TEXT NOT NULL,
      category TEXT NOT NULL,
      provider TEXT NOT NULL,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd REAL NOT NULL DEFAULT 0,
      local_saved_usd REAL NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_approvals (
      id TEXT PRIMARY KEY,
      tool_name TEXT NOT NULL,
      action_summary TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS runtime_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function seedInitialData(db: Database.Database): void {
  const existingModels = db
    .prepare('SELECT COUNT(*) as cnt FROM model_versions')
    .get() as { cnt: number };

  if (existingModels.cnt === 0) {
    const now = new Date().toISOString();
    const baselineLora = JSON.stringify({
      rank: 16,
      alpha: 32,
      dropout: 0.05,
      learningRate: 0.0002,
      epochs: 2,
      batchSize: 2,
      quantizationBits: 4,
      targetModules: ['q_proj', 'k_proj', 'v_proj', 'o_proj', 'gate_proj', 'up_proj', 'down_proj'],
    });
    const baselineEval = JSON.stringify({
      overallScore: 78.4,
      typecheckPassRate: 88.0,
      securityPassRate: 92.0,
      unitTestPassRate: 76.0,
      apiAccuracyScore: 72.0,
      avgLatencyMs: 640,
      evaluatedAt: now,
      checksRun: 12,
      notes: 'Baseline Qwen3-4B Q4_K_M without specialized LoRA adapter yet.',
    });
    const hash = crypto.createHash('sha256').update('codiz-v1.0.0-base').digest('hex');

    db.prepare(
      `INSERT INTO model_versions (
        id, version_tag, foundation_model_id, foundation_model_name,
        adapter_version, adapter_uri, dataset_version, lora_config_json,
        training_date, validation_loss, eval_metrics_json,
        approval_status, deployment_status, previous_production_id, sha256, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'mv-codiz-base-100',
      'codiz-4b-v1.0.0',
      'qwen3-4b-q4km',
      'Codiz Core · Qwen3-4B (Q4_K_M)',
      'adapter-base-0.0.0',
      'gcs://personal-coding-ai/adapters/production/adapter-base-0.0.0',
      'ds-v1.0.0',
      baselineLora,
      now,
      0.642,
      baselineEval,
      'approved',
      'production',
      null,
      hash,
      now
    );
  }

  const existingDocs = db
    .prepare('SELECT COUNT(*) as cnt FROM knowledge_documents')
    .get() as { cnt: number };

  if (existingDocs.cnt === 0) {
    const seedDocs = [
      {
        collection: 'cloudflare',
        title: 'Cloudflare Workers + Hono + D1 & R2 Production Patterns',
        sourceUrl: 'https://developers.cloudflare.com/workers/',
        docVersion: '2026.1',
        content:
          'Cloudflare Workers execute on V8 isolates with 0ms cold starts. Bindings (D1 SQLite, R2 object storage, KV, Durable Objects, Queues) are typed via `Bindings` in Hono (`new Hono<{ Bindings: Env }>()`). Use `c.executionCtx.waitUntil(...)` for background logging and parameterized `.bind()` queries in D1 to prevent SQL injection. Deploy via `wrangler deploy` with `wrangler.toml`.',
        codeBlocks: [
          `import { Hono } from 'hono';\ntype Env = { DB: D1Database; BUCKET: R2Bucket; CACHE: KVNamespace };\nconst app = new Hono<{ Bindings: Env }>();\napp.get('/users/:id', async (c) => {\n  const row = await c.env.DB.prepare('SELECT id, name FROM users WHERE id = ?').bind(c.req.param('id')).first();\n  return row ? c.json(row) : c.json({ error: 'Not found' }, 404);\n});`,
        ],
      },
      {
        collection: 'google-cloud',
        title: 'Google Cloud Run Scale-to-Zero & GCS IAM Best Practices',
        sourceUrl: 'https://cloud.google.com/run/docs/configuring/services/gpu',
        docVersion: '2026.1',
        content:
          'To keep Cloud Run under a $20/month budget, configure `--min-instances=0`, `--max-instances=1` on GPU services, `--cpu-throttling`, and use Cloud Run Jobs for batch LoRA fine-tuning. Never embed service account JSON keys inside images; attach a dedicated IAM service account (`roles/storage.objectAdmin`, `roles/secretmanager.secretAccessor`) and read secrets via Secret Manager.',
        codeBlocks: [
          `gcloud run deploy codiz-api \\\n  --source . --region europe-west1 \\\n  --min-instances 0 --max-instances 2 \\\n  --memory 512Mi --cpu 1 \\\n  --service-account codiz-runner@PROJECT_ID.iam.gserviceaccount.com`,
        ],
      },
      {
        collection: 'meta',
        title: 'Meta WhatsApp Cloud API Webhook Verification & Security',
        sourceUrl: 'https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks',
        docVersion: 'v21.0',
        content:
          'Meta Webhooks require two endpoints: GET for `hub.verify_token` challenge validation and POST for inbound events. Always verify the `X-Hub-Signature-256` HMAC-SHA256 signature against your Meta App Secret using `crypto.timingSafeEqual` on the raw request body before parsing JSON. Respect graph rate limits and version pin `/v21.0/{phone_number_id}/messages`.',
        codeBlocks: [
          `import crypto from 'node:crypto';\nexport function verifyMetaSignature(rawBody: string, headerSig: string, appSecret: string): boolean {\n  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');\n  if (expected.length !== headerSig.length) return false;\n  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(headerSig));\n}`,
        ],
      },
      {
        collection: 'flutter',
        title: 'Flutter & Dart Low-Bandwidth Offline-First Architecture',
        sourceUrl: 'https://docs.flutter.dev/app-architecture',
        docVersion: '3.27',
        content:
          'For African mobile networks with intermittent connectivity, structure Flutter apps using Repository pattern + local SQLite (`drift` or `sqflite`) + optimistic UI updates + exponential backoff retries. Avoid large bundle bloat by deferring assets and using `const` constructors to minimize widget rebuilds on budget Android devices.',
        codeBlocks: [
          `class SyncQueueRepository {\n  Future<void> enqueue(PendingMutation item) async {\n    await localDb.insertMutation(item);\n    unawaited(tryFlushWhenOnline());\n  }\n}`,
        ],
      },
      {
        collection: 'typescript',
        title: 'Hono + Zod Strict Type-Safe API Validation',
        sourceUrl: 'https://hono.dev/docs/guides/validation',
        docVersion: '4.x',
        content:
          'Validate every Hono JSON body and query parameter with Zod `safeParse` before touching database or LLM calls. Return structured 400 validation issues and never pass unvalidated user fields to shell or filesystem APIs.',
        codeBlocks: [
          `const Payload = z.object({ prompt: z.string().min(1).max(16000) });\nconst parsed = Payload.safeParse(await c.req.json());\nif (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);`,
        ],
      },
    ];

    const now = new Date().toISOString();
    const insertDoc = db.prepare(
      `INSERT INTO knowledge_documents (id, collection, title, source_url, doc_version, content_hash, raw_gcs_uri, chunk_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertChunk = db.prepare(
      `INSERT INTO knowledge_chunks (id, document_id, collection, title, source_url, chunk_index, content, code_blocks_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (let i = 0; i < seedDocs.length; i++) {
      const d = seedDocs[i];
      const docId = `kdoc-seed-${i + 1}`;
      const hash = crypto.createHash('sha256').update(d.content).digest('hex');
      insertDoc.run(
        docId,
        d.collection,
        d.title,
        d.sourceUrl,
        d.docVersion,
        hash,
        `gcs://personal-coding-ai/knowledge/${d.collection}/${docId}.md`,
        1,
        now
      );
      insertChunk.run(
        `kchunk-seed-${i + 1}`,
        docId,
        d.collection,
        d.title,
        d.sourceUrl,
        0,
        d.content,
        JSON.stringify(d.codeBlocks),
        now
      );
    }
  }
}
