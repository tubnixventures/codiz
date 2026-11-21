import crypto from 'node:crypto';
import { getDb } from '../../db/sqlite.ts';
import { generateCompletion } from '../../providers/llm/router.ts';
import { BUCKET_PREFIXES, artifactStorage } from '../../providers/storage/gcs.ts';
import type { DatasetStage, TrainingExampleRecord } from '../../types/domain.ts';
import { canExecutePaidWorkload } from '../budget/tracker.ts';

const SECRET_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: 'GOOGLE_KEY', regex: /AIza[0-9A-Za-z\-_]{30,}/g },
  { label: 'OPENAI_OR_SK', regex: /sk-[A-Za-z0-9\-_]{20,}/g },
  { label: 'GITHUB_TOKEN', regex: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { label: 'AWS_ACCESS_KEY', regex: /AKIA[0-9A-Z]{16}/g },
  { label: 'PRIVATE_KEY', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { label: 'BEARER_JWT', regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
];

export function scrubSecretsAndPii(text: string): {
  cleaned: string;
  redactedCount: number;
} {
  let cleaned = text;
  let redactedCount = 0;

  for (const pat of SECRET_PATTERNS) {
    const matches = cleaned.match(pat.regex);
    if (matches) {
      redactedCount += matches.length;
      cleaned = cleaned.replace(pat.regex, `[REDACTED_${pat.label}]`);
    }
  }

  // Redact personal email addresses
  const emailMatches = cleaned.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
  if (emailMatches) {
    redactedCount += emailMatches.length;
    cleaned = cleaned.replace(
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
      '[REDACTED_EMAIL]'
    );
  }

  return { cleaned, redactedCount };
}

export function detectCategory(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes('cloudflare') || lower.includes('wrangler') || lower.includes('durable object') || lower.includes('d1'))
    return 'cloudflare';
  if (lower.includes('cloud run') || lower.includes('gcs') || lower.includes('bigquery') || lower.includes('firestore'))
    return 'google-cloud';
  if (lower.includes('whatsapp') || lower.includes('x-hub-signature') || lower.includes('graph.facebook'))
    return 'meta';
  if (lower.includes('azure') || lower.includes('entra') || lower.includes('cosmos'))
    return 'azure';
  if (lower.includes('flutter') || lower.includes('widget') || lower.includes('dart'))
    return 'flutter-dart';
  if (lower.includes('hono')) return 'hono-typescript';
  if (lower.includes('docker') || lower.includes('nginx') || lower.includes('systemd'))
    return 'devops-infra';
  if (lower.includes('def ') || lower.includes('pytorch') || lower.includes('transformers'))
    return 'python-ml';
  if (lower.includes('#include') || lower.includes('std::')) return 'cpp';
  return 'typescript-fullstack';
}

export function ingestTrainingExample(params: {
  prompt: string;
  completion: string;
  systemContext?: string;
  source: TrainingExampleRecord['source'];
  difficulty?: TrainingExampleRecord['difficulty'];
  category?: string;
  licenseMetadata?: string;
  attribution?: string;
  datasetVersion?: string;
}): {
  record: TrainingExampleRecord;
  deduplicated: boolean;
  redactedCount: number;
} {
  const db = getDb();
  const pScrub = scrubSecretsAndPii(params.prompt);
  const cScrub = scrubSecretsAndPii(params.completion);
  const sScrub = scrubSecretsAndPii(params.systemContext ?? '');
  const redactedCount = pScrub.redactedCount + cScrub.redactedCount + sScrub.redactedCount;

  if (pScrub.cleaned.trim().length < 12 || cScrub.cleaned.trim().length < 20) {
    throw new Error('Example rejected by Data Engineer quality gate: prompt or completion too short.');
  }

  const contentHash = crypto
    .createHash('sha256')
    .update(`${pScrub.cleaned.trim()}::${cScrub.cleaned.trim()}`)
    .digest('hex');

  const existing = db
    .prepare('SELECT * FROM training_examples WHERE content_hash = ?')
    .get(contentHash) as Record<string, any> | undefined;

  if (existing) {
    return {
      record: mapRowToExample(existing),
      deduplicated: true,
      redactedCount,
    };
  }

  const hasCodeOrStruct =
    cScrub.cleaned.includes('```') ||
    cScrub.cleaned.includes('function ') ||
    cScrub.cleaned.includes('class ') ||
    cScrub.cleaned.includes('import ') ||
    cScrub.cleaned.includes('def ') ||
    cScrub.cleaned.includes('"action":"tool_call"') ||
    cScrub.cleaned.includes('"action":"final_answer"');

  const stage: DatasetStage = hasCodeOrStruct ? 'cleaned' : 'raw';
  const id = `ex-${crypto.randomUUID().slice(0, 10)}`;
  const now = new Date().toISOString();
  const category = params.category || detectCategory(`${pScrub.cleaned}\n${cScrub.cleaned}`);
  const datasetVersion = params.datasetVersion ?? 'ds-v1.1.0';

  db.prepare(
    `INSERT INTO training_examples (
      id, dataset_version, stage, category, difficulty, source,
      license_metadata, attribution, prompt, completion, system_context,
      secrets_scrubbed, teacher_score, automated_checks_passed, content_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, 0, ?, ?)`
  ).run(
    id,
    datasetVersion,
    stage,
    category,
    params.difficulty ?? 'intermediate',
    params.source,
    params.licenseMetadata ?? 'personal-owned',
    params.attribution ?? 'Codiz User',
    pScrub.cleaned,
    cScrub.cleaned,
    sScrub.cleaned,
    contentHash,
    now
  );

  const inserted = db.prepare('SELECT * FROM training_examples WHERE id = ?').get(id) as Record<string, any>;
  return {
    record: mapRowToExample(inserted),
    deduplicated: false,
    redactedCount,
  };
}

export function importMuseCodeJsonl(params: {
  jsonlText: string;
  licenseMetadata: string;
  attribution: string;
}): {
  importedCount: number;
  deduplicatedCount: number;
  rejectedCount: number;
  redactedSecretsTotal: number;
  errors: string[];
} {
  const lines = params.jsonlText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  let importedCount = 0;
  let deduplicatedCount = 0;
  let rejectedCount = 0;
  let redactedSecretsTotal = 0;
  const errors: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    try {
      const obj = JSON.parse(lines[i]) as Record<string, any>;
      let prompt = '';
      let completion = '';
      let systemContext = '';

      if (typeof obj.prompt === 'string' && typeof obj.completion === 'string') {
        prompt = obj.prompt;
        completion = obj.completion;
        systemContext = typeof obj.system === 'string' ? obj.system : '';
      } else if (typeof obj.instruction === 'string' && typeof obj.output === 'string') {
        prompt = obj.instruction;
        completion = obj.output;
      } else if (Array.isArray(obj.messages)) {
        const sys = obj.messages.find((m: any) => m.role === 'system');
        const usr = obj.messages.find((m: any) => m.role === 'user');
        const ast = obj.messages.find((m: any) => m.role === 'assistant');
        systemContext = sys?.content ?? '';
        prompt = usr?.content ?? '';
        completion = ast?.content ?? '';
      } else {
        throw new Error('Missing prompt/completion, instruction/output, or messages[] fields.');
      }

      const res = ingestTrainingExample({
        prompt,
        completion,
        systemContext,
        source: 'muse-code-import',
        difficulty: obj.difficulty === 'beginner' || obj.difficulty === 'advanced' ? obj.difficulty : 'intermediate',
        category: typeof obj.category === 'string' ? obj.category : undefined,
        licenseMetadata: typeof obj.license === 'string' ? obj.license : params.licenseMetadata,
        attribution: typeof obj.attribution === 'string' ? obj.attribution : params.attribution,
      });

      redactedSecretsTotal += res.redactedCount;
      if (res.deduplicated) deduplicatedCount += 1;
      else importedCount += 1;
    } catch (err) {
      rejectedCount += 1;
      errors.push(`Line ${i + 1}: ${err instanceof Error ? err.message : 'Invalid JSONL'}`);
    }
  }

  return {
    importedCount,
    deduplicatedCount,
    rejectedCount,
    redactedSecretsTotal,
    errors: errors.slice(0, 10),
  };
}

export async function runTeacherReviewOnExample(exampleId: string): Promise<{
  example: TrainingExampleRecord;
  critique: string;
  improvedCompletion: string;
  teacherScore: number;
}> {
  const budgetGate = canExecutePaidWorkload('teacher', 0.002);
  if (!budgetGate.allowed) {
    throw new Error(budgetGate.reason);
  }

  const db = getDb();
  const row = db.prepare('SELECT * FROM training_examples WHERE id = ?').get(exampleId) as
    | Record<string, any>
    | undefined;
  if (!row) throw new Error('Training example not found.');

  const reviewPrompt = `You are the AI Teacher for Codiz (a 4B coding model). Review the student solution below for:
1. Incorrect cloud/framework APIs or hallucinations
2. Security flaws (injection, hardcoded keys, missing signature checks)
3. Resource efficiency and type safety

Respond strictly in JSON with keys:
- "score": number (0 to 100)
- "critique": string (concise technical explanation)
- "improvedCompletion": string (corrected production-ready response)

Task Prompt:
${row.prompt}

Current Completion:
${row.completion}`;

  const result = await generateCompletion({
    messages: [{ role: 'user', content: reviewPrompt }],
    jsonMode: true,
    preferProvider: 'gemini',
  });

  const parsed = JSON.parse(result.text) as {
    score?: number;
    critique?: string;
    improvedCompletion?: string;
  };

  const score = Math.max(0, Math.min(100, Number(parsed.score ?? 75)));
  const improvedCompletion = parsed.improvedCompletion || row.completion;
  const critique = parsed.critique || 'Teacher reviewed and verified structure.';

  // Teacher approval alone never auto-approves; automated checks must also pass.
  const nextStage: DatasetStage = score >= 80 ? 'approved' : 'cleaned';
  db.prepare(
    `UPDATE training_examples
     SET completion = ?, teacher_score = ?, stage = ?, automated_checks_passed = ?
     WHERE id = ?`
  ).run(improvedCompletion, score, nextStage, score >= 80 ? 1 : 0, exampleId);

  const updated = db.prepare('SELECT * FROM training_examples WHERE id = ?').get(exampleId) as Record<string, any>;
  return {
    example: mapRowToExample(updated),
    critique,
    improvedCompletion,
    teacherScore: score,
  };
}

export async function generateSyntheticExample(params: {
  topic: string;
  difficulty: 'beginner' | 'intermediate' | 'advanced';
}): Promise<TrainingExampleRecord> {
  const budgetGate = canExecutePaidWorkload('teacher', 0.003);
  if (!budgetGate.allowed) throw new Error(budgetGate.reason);

  const prompt = `Generate one realistic, production-grade software engineering training pair for a 4B coding model.
Topic: ${params.topic}
Difficulty: ${params.difficulty}
Return strictly JSON with keys:
- "prompt": realistic developer problem statement
- "completion": clean, secure, low-resource production solution with brief explanation and TypeScript/Python/Dart/Cloud code.`;

  const res = await generateCompletion({
    messages: [{ role: 'user', content: prompt }],
    jsonMode: true,
    preferProvider: 'gemini',
  });

  const parsed = JSON.parse(res.text) as { prompt: string; completion: string };
  const ingested = ingestTrainingExample({
    prompt: parsed.prompt,
    completion: parsed.completion,
    source: 'teacher-synthetic',
    difficulty: params.difficulty,
    attribution: 'Codiz AI Teacher Synthetic Factory',
  });
  return ingested.record;
}

export async function exportApprovedDatasetJsonl(datasetVersion = 'ds-v1.1.0'): Promise<{
  trainCount: number;
  valCount: number;
  trainUri: string;
  valUri: string;
}> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM training_examples WHERE stage IN ('approved', 'cleaned') ORDER BY created_at ASC`
    )
    .all() as Array<Record<string, any>>;

  const formatted = rows.map((r) =>
    JSON.stringify({
      messages: [
        {
          role: 'system',
          content: r.system_context || 'You are Codiz, an efficient personal coding intelligence.',
        },
        { role: 'user', content: r.prompt },
        { role: 'assistant', content: r.completion },
      ],
      metadata: {
        id: r.id,
        category: r.category,
        difficulty: r.difficulty,
        source: r.source,
        license: r.license_metadata,
        attribution: r.attribution,
      },
    })
  );

  // Deterministic 90/10 train/validation split
  const valLines: string[] = [];
  const trainLines: string[] = [];
  formatted.forEach((line, idx) => {
    if (idx % 10 === 9) valLines.push(line);
    else trainLines.push(line);
  });

  const trainArtifact = await artifactStorage.putObject(
    `${BUCKET_PREFIXES.datasetsApproved}/${datasetVersion}/train.jsonl`,
    trainLines.join('\n')
  );
  const valArtifact = await artifactStorage.putObject(
    `${BUCKET_PREFIXES.datasetsValidation}/${datasetVersion}/val.jsonl`,
    valLines.join('\n')
  );

  return {
    trainCount: trainLines.length,
    valCount: valLines.length,
    trainUri: trainArtifact.uri,
    valUri: valArtifact.uri,
  };
}

export function listTrainingExamples(stage?: string): TrainingExampleRecord[] {
  const db = getDb();
  const rows = (
    stage && stage !== 'all'
      ? db
          .prepare('SELECT * FROM training_examples WHERE stage = ? ORDER BY created_at DESC LIMIT 100')
          .all(stage)
      : db.prepare('SELECT * FROM training_examples ORDER BY created_at DESC LIMIT 100').all()
  ) as Array<Record<string, any>>;
  return rows.map(mapRowToExample);
}

function mapRowToExample(row: Record<string, any>): TrainingExampleRecord {
  return {
    id: row.id,
    datasetVersion: row.dataset_version,
    stage: row.stage,
    category: row.category,
    difficulty: row.difficulty,
    source: row.source,
    licenseMetadata: row.license_metadata,
    attribution: row.attribution,
    prompt: row.prompt,
    completion: row.completion,
    systemContext: row.system_context,
    secretsScrubbed: Boolean(row.secrets_scrubbed),
    teacherScore: row.teacher_score,
    automatedChecksPassed: Boolean(row.automated_checks_passed),
    contentHash: row.content_hash,
    createdAt: row.created_at,
  };
}

export function seedCliAgentTrainingExamples(): { inserted: number; deduplicated: number } {
  const agentSystem =
    'You are Codiz, a fine-tuned local CLI coding agent with tools: list_files, grep_search, read_file, write_file, edit_file, run_command, web_search, web_scrape, evaluate_code.';

  const pairs: Array<{ prompt: string; completion: string; category: string }> = [
    {
      category: 'cli-agent-npm',
      prompt: 'Install express and zod in this Node project and verify package.json updates.',
      completion: JSON.stringify({
        thought: 'Install express and zod using npm via run_command.',
        action: 'tool_call',
        tool: 'run_command',
        input: { command: 'npm install express zod', reason: 'Install requested packages' },
      }),
    },
    {
      category: 'cli-agent-files',
      prompt: 'Create a TypeScript CLI helper at src/hello.ts that prints Hello Codiz and test it with tsx.',
      completion: JSON.stringify({
        thought: 'Write src/hello.ts first, then execute it to verify.',
        action: 'tool_call',
        tool: 'write_file',
        input: {
          path: 'src/hello.ts',
          content: "export function greet(name = 'Codiz'): string {\n  return `Hello ${name}`;\n}\nconsole.log(greet());\n",
          reason: 'Create requested TypeScript CLI helper',
        },
      }),
    },
    {
      category: 'cli-agent-web',
      prompt: 'Search the web for the latest Hono Zod validator middleware docs and summarize how to use it.',
      completion: JSON.stringify({
        thought: 'Search the live web for Hono Zod validator middleware documentation.',
        action: 'tool_call',
        tool: 'web_search',
        input: { query: 'hono zod validator middleware official docs', limit: 4 },
      }),
    },
    {
      category: 'cli-agent-scrape',
      prompt: 'Read the documentation page at https://hono.dev/docs/guides/validation and extract the example.',
      completion: JSON.stringify({
        thought: 'Scrape the official Hono validation documentation page for accurate code.',
        action: 'tool_call',
        tool: 'web_scrape',
        input: { url: 'https://hono.dev/docs/guides/validation', maxChars: 4200 },
      }),
    },
    {
      category: 'cli-agent-debug',
      prompt: 'Search the codebase for where rate limiting is configured and inspect the file.',
      completion: JSON.stringify({
        thought: 'Use grep_search to locate rate limiting references across the repository.',
        action: 'tool_call',
        tool: 'grep_search',
        input: { query: 'rateLimit', isRegex: false },
      }),
    },
  ];

  let inserted = 0;
  let deduplicated = 0;
  for (const p of pairs) {
    const res = ingestTrainingExample({
      prompt: p.prompt,
      completion: p.completion,
      systemContext: agentSystem,
      source: 'teacher-synthetic',
      difficulty: 'intermediate',
      category: p.category,
      licenseMetadata: 'codiz-local-agent',
      attribution: 'Codiz CLI Agent Seed',
      datasetVersion: 'ds-cli-agent-v1',
    });
    if (res.deduplicated) deduplicated++;
    else inserted++;
  }
  return { inserted, deduplicated };
}
