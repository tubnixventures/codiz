import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codiz-test-'));
process.env.NODE_ENV = 'test';
process.env.CODIZ_DATA_DIR = tempDir;
process.env.CODIZ_WORKSPACE_ROOT = process.cwd();
process.env.MONTHLY_BUDGET_USD = '20';

import { resetEnvCache } from '../src/server/config/env.ts';
import { closeDb, getDb } from '../src/server/db/sqlite.ts';
import { createCodizApiApp } from '../src/server/app.ts';
import { resolveSafeWorkspacePath } from '../src/server/services/repository/indexer.ts';
import { validateSafeExternalUrl } from '../src/server/services/retrieval/knowledge.ts';
import {
  importMuseCodeJsonl,
  scrubSecretsAndPii,
} from '../src/server/services/teacher/factory.ts';
import { evaluateCodeSnippet } from '../src/server/services/evaluator/runner.ts';
import {
  dispatchLoraTrainingJob,
  promoteModelVersion,
  rollbackProductionModel,
} from '../src/server/services/model-registry/registry.ts';
import { canExecutePaidWorkload, getBudgetSnapshot, recordUsage } from '../src/server/services/budget/tracker.ts';

resetEnvCache();
getDb();

const app = createCodizApiApp();
let sessionToken = '';

after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('Codiz Platform Integration & Security Suite', () => {
  it('exposes public health checks and locks protected routes', async () => {
    const healthRes = await app.request('/api/health');
    assert.equal(healthRes.status, 200);
    const healthJson = (await healthRes.json()) as { status: string; service: string };
    assert.equal(healthJson.status, 'ok');
    assert.equal(healthJson.service, 'codiz-hono-gateway');

    const unauthRes = await app.request('/api/models');
    assert.equal(unauthRes.status, 401);
  });

  it('supports scrypt passphrase bootstrap and Bearer session access', async () => {
    const bootRes = await app.request('/api/auth/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: 'codiz-test-passphrase' }),
    });
    assert.equal(bootRes.status, 201);
    const bootJson = (await bootRes.json()) as { token: string };
    assert.ok(bootJson.token.startsWith('cdz_'));
    sessionToken = bootJson.token;

    const modelsRes = await app.request('/api/models', {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    assert.equal(modelsRes.status, 200);
  });

  it('scrubs secrets and PII from training data and deduplicates Muse Code JSONL imports', () => {
    const dirty = 'Use key sk-1234567890abcdefghijklmnop and contact dev@example.com';
    const scrubbed = scrubSecretsAndPii(dirty);
    assert.equal(scrubbed.redactedCount, 2);
    assert.ok(!scrubbed.cleaned.includes('sk-1234567890'));
    assert.ok(!scrubbed.cleaned.includes('dev@example.com'));

    const line = JSON.stringify({
      prompt: 'Write a parameterized Hono D1 query in TypeScript for user lookup.',
      completion:
        "export async function findUser(db: any, id: string) {\n  return db.prepare('SELECT id FROM users WHERE id = ?').bind(id).first();\n}",
    });

    const first = importMuseCodeJsonl({
      jsonlText: `${line}\n${line}`,
      licenseMetadata: 'personal-test',
      attribution: 'Muse Code',
    });
    assert.equal(first.importedCount, 1);
    assert.equal(first.deduplicatedCount, 1);
  });

  it('enforces workspace path confinement and blocks SSRF metadata/private URLs', () => {
    assert.throws(() => resolveSafeWorkspacePath('../../etc/passwd'), /sandbox boundary/);
    assert.throws(() => validateSafeExternalUrl('http://169.254.169.254/latest/meta-data/'), /Blocked/);
    assert.throws(() => validateSafeExternalUrl('http://127.0.0.1:8080/internal'), /Blocked/);
    const okUrl = validateSafeExternalUrl('https://developers.cloudflare.com/workers/');
    assert.equal(okUrl.hostname, 'developers.cloudflare.com');
  });

  it('runs real TypeScript diagnostics + security gates and enforces promotion/rollback', async () => {
    const badSnippet = evaluateCodeSnippet('const x = eval("1+1");', 'typescript');
    assert.equal(badSnippet.passed, false);
    assert.ok(badSnippet.securityIssues.length > 0);

    const goodSnippet = evaluateCodeSnippet(
      'export function add(a: number, b: number): number { return a + b; }',
      'typescript'
    );
    assert.equal(goodSnippet.passed, true);

    const job = await dispatchLoraTrainingJob({
      foundationModelId: 'qwen3-4b-bf16',
      target: 'local-gpu',
      confirmSpendAllowance: false,
      loraConfig: {
        rank: 16,
        alpha: 32,
        dropout: 0.05,
        learningRate: 0.0002,
        epochs: 2,
        batchSize: 2,
        quantizationBits: 4,
        targetModules: ['q_proj', 'v_proj'],
      },
    });

    // Cannot promote without benchmark evaluation
    assert.throws(() => promoteModelVersion(job.candidateModel.id), /without running independent/);

    const evalRes = await app.request(`/api/models/${job.candidateModel.id}/evaluate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    assert.equal(evalRes.status, 200);

    const promoted = promoteModelVersion(job.candidateModel.id);
    assert.equal(promoted.deploymentStatus, 'production');

    const rolledBack = rollbackProductionModel();
    assert.equal(rolledBack.versionTag, 'codiz-4b-v1.0.0');
  });

  it('enforces 90% and 100% monthly budget thresholds to prevent surprise cloud bills', () => {
    recordUsage({
      category: 'cloud-run-gpu',
      provider: 'test',
      tokensIn: 100,
      tokensOut: 100,
      estimatedCostUsd: 18.5,
    });

    const snap = getBudgetSnapshot();
    assert.equal(snap.thresholdState, 'restrict_90');
    const gate = canExecutePaidWorkload('training-gpu', 1.0);
    assert.equal(gate.allowed, false);
  });

  it('exposes OpenAI-compatible /api/v1/models and persists self-hosted Qwen runtime config', async () => {
    const modelsRes = await app.request('/api/v1/models', {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    assert.equal(modelsRes.status, 200);
    const modelsJson = (await modelsRes.json()) as { object: string; data: Array<{ owned_by: string }> };
    assert.equal(modelsJson.object, 'list');
    assert.equal(modelsJson.data[0].owned_by, 'codiz-self-hosted');

    const saveRes = await app.request('/api/models/runtime-config', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({
        inferenceMode: 'local-ollama',
        selfHostedBaseUrl: 'http://127.0.0.1:11434/v1',
        selfHostedModel: 'codiz-qwen3-4b-lora',
      }),
    });
    assert.equal(saveRes.status, 200);
    const savedJson = (await saveRes.json()) as { config: { selfHostedModel: string } };
    assert.equal(savedJson.config.selfHostedModel, 'codiz-qwen3-4b-lora');
  });

  it('executes agentic evaluate_code and queues propose_file_write for human approval', async () => {
    const evalToolRes = await app.request('/api/repo/tools/run', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({
        toolName: 'evaluate_code',
        input: { code: 'export const x: number = 42;', language: 'typescript' },
      }),
    });
    assert.equal(evalToolRes.status, 200);
    const evalJson = (await evalToolRes.json()) as { ok: boolean; result: { passed: boolean } };
    assert.equal(evalJson.ok, true);
    assert.equal(evalJson.result.passed, true);

    const writeToolRes = await app.request('/api/repo/tools/run', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({
        toolName: 'propose_file_write',
        input: {
          path: 'tmp-agent-test.txt',
          content: 'hello',
          reason: 'Verify sandboxed approval queue',
        },
      }),
    });
    assert.equal(writeToolRes.status, 200);
    const writeJson = (await writeToolRes.json()) as {
      ok: boolean;
      result: { status: string; approvalId: string };
    };
    assert.equal(writeJson.result.status, 'awaiting_human_approval');
    assert.ok(writeJson.result.approvalId.startsWith('apr-'));
  });

  it('validates propose_command blocklist, queues safe commands, and runs CLI diagnostics', async () => {
    const blockedRes = await app.request('/api/repo/tools/run', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({
        toolName: 'propose_command',
        input: {
          command: 'rm -rf /',
          reason: 'Should be blocked by safety filter',
        },
      }),
    });
    assert.equal(blockedRes.status, 400);

    const safeRes = await app.request('/api/repo/tools/run', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({
        toolName: 'propose_command',
        input: {
          command: 'npm test',
          reason: 'Verify unit tests pass',
        },
      }),
    });
    assert.equal(safeRes.status, 200);
    const safeJson = (await safeRes.json()) as {
      ok: boolean;
      result: { status: string; approvalId: string };
    };
    assert.equal(safeJson.ok, true);
    assert.equal(safeJson.result.status, 'awaiting_human_approval');
    assert.ok(safeJson.result.approvalId.startsWith('apr-'));

    const { detectMachineProfile } = await import('../src/cli/hardware.ts');
    const profile = detectMachineProfile();
    assert.ok(profile.recommendedThreads >= 2);
    assert.ok(profile.recommendedBaseTag.includes('qwen'));
  });

  it('supports mid-loop write_file, edit_file, grep_search, run_command, web SSRF guard, and agent fine-tune seeding', async () => {
    const { runRegisteredTool } = await import('../src/server/services/agent/tools.ts');
    const { parseDuckDuckGoHtml } = await import('../src/server/services/web/research.ts');
    const { seedCliAgentTrainingExamples } = await import('../src/server/services/teacher/factory.ts');

    // 1. DuckDuckGo HTML parsing & SSRF filtering
    const sampleHtml = `
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fhono.dev%2Fdocs">Hono Docs</a>
      <a class="result__snippet">Fast web framework</a>
      <a class="result__a" href="http://127.0.0.1:8080/secret">Internal Blocked</a>
      <a class="result__snippet">Should be blocked</a>
    `;
    const parsedResults = parseDuckDuckGoHtml(sampleHtml, 5);
    assert.equal(parsedResults.length, 1);
    assert.equal(parsedResults[0].url, 'https://hono.dev/docs');

    const ssrfScrape = await runRegisteredTool('web_scrape', { url: 'http://169.254.169.254/latest/meta-data/' });
    assert.equal(ssrfScrape.ok, false);

    // 2. Mid-loop create/edit/grep/command execution with confirmation hook
    const tmpRel = '.codiz-tmp-agent-test.js';
    const tmpAbs = resolveSafeWorkspacePath(tmpRel);
    try {
      const writeRes = await runRegisteredTool(
        'write_file',
        { path: tmpRel, content: 'console.log("step-one");\n', reason: 'Test file creation' },
        { onConfirmAction: async () => true }
      );
      assert.equal(writeRes.ok, true);
      assert.equal((writeRes.result as { status: string }).status, 'applied');

      const editRes = await runRegisteredTool(
        'edit_file',
        { path: tmpRel, oldText: 'step-one', newText: 'step-two', reason: 'Test targeted edit' },
        { onConfirmAction: async () => true }
      );
      assert.equal(editRes.ok, true);

      const cmdRes = await runRegisteredTool(
        'run_command',
        { command: `node ${tmpRel}`, reason: 'Verify edited file output' },
        { onConfirmAction: async () => true }
      );
      assert.equal(cmdRes.ok, true);
      assert.equal((cmdRes.result as { exitCode: number; stdout: string }).exitCode, 0);
      assert.ok((cmdRes.result as { stdout: string }).stdout.includes('step-two'));
    } finally {
      fs.rmSync(tmpAbs, { force: true });
    }

    // 3. Seed fine-tuning examples for CLI coding agent tools
    const seeded = seedCliAgentTrainingExamples();
    assert.ok(seeded.inserted >= 4);
  });
});
