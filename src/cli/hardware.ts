import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import process from 'node:process';
import { getEnv } from '../server/config/env.ts';
import { getSelfHostedRuntimeConfig, saveSelfHostedRuntimeConfig } from '../server/config/runtime.ts';
import { c } from './ansi.ts';

export interface MachineProfile {
  platform: NodeJS.Platform;
  arch: string;
  cpuModel: string;
  logicalCores: number;
  recommendedThreads: number;
  totalRamGb: number;
  freeRamGb: number;
  tierName: 'feather-cpu' | 'lite-cpu' | 'core-balanced';
  recommendedBaseTag: string;
  tunedModelName: string;
  recommendedCtx: number;
  recommendedBatch: number;
  compactPromptDefault: boolean;
  notes: string;
}

export function detectMachineProfile(): MachineProfile {
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model?.trim() || 'Unknown CPU';
  const logicalCores = Math.max(1, cpus.length);
  const totalRamGb = Number((os.totalmem() / (1024 ** 3)).toFixed(1));
  const freeRamGb = Number((os.freemem() / (1024 ** 3)).toFixed(1));

  // Older dual-core CPUs (e.g. Intel i3-2120 2c/4t) or <= 4 logical cores perform best with 1.5B Q4_K_M + 2 threads
  const isLegacyOrDualCore =
    logicalCores <= 4 || /\bi3-2\d{3}\b|\bi3-3\d{3}\b|\bPentium\b|\bCeleron\b/i.test(cpuModel);

  if (isLegacyOrDualCore || totalRamGb < 10) {
    return {
      platform: os.platform(),
      arch: os.arch(),
      cpuModel,
      logicalCores,
      recommendedThreads: Math.max(2, Math.min(4, Math.floor(logicalCores / 2) || 2)),
      totalRamGb,
      freeRamGb,
      tierName: 'feather-cpu',
      recommendedBaseTag: 'qwen2.5-coder:1.5b-instruct-q4_K_M',
      tunedModelName: 'codiz-local',
      recommendedCtx: 4096,
      recommendedBatch: 128,
      compactPromptDefault: true,
      notes: 'Tuned for dual-core / CPU-only PCs (e.g. i3-2120 + 12GB RAM + HDD): ~1.4GB RAM, ~6-10 tok/s.',
    };
  }

  if (logicalCores <= 8 || totalRamGb < 16) {
    return {
      platform: os.platform(),
      arch: os.arch(),
      cpuModel,
      logicalCores,
      recommendedThreads: Math.max(2, Math.min(6, Math.floor(logicalCores / 2))),
      totalRamGb,
      freeRamGb,
      tierName: 'lite-cpu',
      recommendedBaseTag: 'qwen2.5-coder:3b-instruct-q4_K_M',
      tunedModelName: 'codiz-local',
      recommendedCtx: 6144,
      recommendedBatch: 256,
      compactPromptDefault: true,
      notes: 'Balanced 3B Q4_K_M profile (~2.4GB RAM) for mid-range CPU setups.',
    };
  }

  return {
    platform: os.platform(),
    arch: os.arch(),
    cpuModel,
    logicalCores,
    recommendedThreads: Math.max(4, Math.min(8, Math.floor(logicalCores / 2))),
    totalRamGb,
    freeRamGb,
    tierName: 'core-balanced',
    recommendedBaseTag: 'qwen3:4b-q4_K_M',
    tunedModelName: 'codiz-local',
    recommendedCtx: 8192,
    recommendedBatch: 512,
    compactPromptDefault: false,
    notes: 'Full 4B Q4_K_M profile (~3.4GB RAM) for high-core CPUs / GPU machines.',
  };
}

export function checkOllamaCli(): { installed: boolean; version?: string } {
  try {
    const out = execFileSync('ollama', ['--version'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { installed: true, version: out.trim() };
  } catch {
    return { installed: false };
  }
}

export async function listOllamaModels(baseUrl: string): Promise<{
  reachable: boolean;
  models: string[];
}> {
  const root = baseUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${root}/api/tags`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return { reachable: false, models: [] };
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    return {
      reachable: true,
      models: (data.models ?? []).map((m) => m.name || '').filter(Boolean),
    };
  } catch {
    return { reachable: false, models: [] };
  }
}

export function buildModelfileContent(profile: MachineProfile, baseModelTag?: string): string {
  const baseTag = baseModelTag || profile.recommendedBaseTag;
  return `FROM ${baseTag}
PARAMETER temperature 0.2
PARAMETER num_ctx ${profile.recommendedCtx}
PARAMETER num_thread ${profile.recommendedThreads}
PARAMETER num_batch ${profile.recommendedBatch}
PARAMETER num_predict 1024
SYSTEM """You are Codiz, a fast, security-focused software engineering agent. Inspect files before editing, write type-safe minimal code, never expose secrets, and verify changes."""
`;
}

export async function runDoctorCommand(): Promise<void> {
  const env = getEnv();
  const profile = detectMachineProfile();
  const ollamaCli = checkOllamaCli();
  const ollamaServer = await listOllamaModels(env.LOCAL_LLM_BASE_URL);

  console.log('');
  console.log(c.bold(c.emerald('Codiz Local Hardware & Runtime Diagnostics')));
  console.log(c.slate('─'.repeat(58)));
  console.log(`  Workspace:       ${c.white(env.CODIZ_WORKSPACE_ROOT)}`);
  console.log(`  Data Directory:  ${c.white(env.CODIZ_DATA_DIR)}`);
  console.log(`  OS / Arch:       ${profile.platform} (${profile.arch})`);
  console.log(`  CPU:             ${profile.cpuModel} (${profile.logicalCores} logical threads)`);
  console.log(`  Memory:          ${profile.totalRamGb} GB total (${profile.freeRamGb} GB free)`);
  console.log(`  Hardware Tier:   ${c.cyan(profile.tierName)} — ${profile.notes}`);
  console.log(
    `  Ollama CLI:      ${ollamaCli.installed ? c.green(`Installed (${ollamaCli.version})`) : c.amber('Not found in PATH (install from https://ollama.com)')}`
  );
  console.log(
    `  Ollama Server:   ${ollamaServer.reachable ? c.green(`Online at ${env.LOCAL_LLM_BASE_URL}`) : c.amber(`Offline at ${env.LOCAL_LLM_BASE_URL}`)}`
  );
  console.log(
    `  Pulled Models:   ${ollamaServer.models.length > 0 ? ollamaServer.models.join(', ') : c.slate('none detected')}`
  );
  console.log(
    `  Gemini Fallback: ${env.GEMINI_API_KEY ? c.green('Configured (server-side env)') : c.slate('Not set (100% offline local mode)')}`
  );
  console.log(c.slate('─'.repeat(58)));
  console.log(`  Recommended Qwen tag: ${c.bold(c.cyan(profile.recommendedBaseTag))}`);
  console.log('');
}

export async function runTuneCommand(baseOverride?: string, quiet = false): Promise<boolean> {
  const env = getEnv();
  const profile = detectMachineProfile();
  const baseTag = baseOverride || profile.recommendedBaseTag;

  fs.mkdirSync(env.CODIZ_DATA_DIR, { recursive: true });
  const modelfilePath = path.join(env.CODIZ_DATA_DIR, 'Modelfile.codiz');
  fs.writeFileSync(modelfilePath, buildModelfileContent(profile, baseTag), 'utf8');

  if (!quiet) {
    console.log('');
    console.log(c.bold(c.emerald(`Tuning Codiz for ${profile.cpuModel}`)));
    console.log(`  • Profile:     ${c.cyan(profile.tierName)} (threads=${profile.recommendedThreads}, ctx=${profile.recommendedCtx}, batch=${profile.recommendedBatch})`);
    console.log(`  • Base model:  ${c.white(baseTag)}`);
    console.log(`  • Modelfile:   ${c.slate(modelfilePath)}`);
  }

  const ollamaCli = checkOllamaCli();
  if (!ollamaCli.installed) {
    if (!quiet) {
      console.log(c.amber('\nOllama CLI is not installed yet. Install Ollama from https://ollama.com and re-run `codiz`.'));
    }
    return false;
  }

  const server = await listOllamaModels(env.LOCAL_LLM_BASE_URL);
  if (!server.models.some((m) => m === baseTag || m.startsWith(baseTag.split(':')[0] + ':'))) {
    console.log(c.cyan(`\nPulling ${baseTag} once for local offline inference...`));
    const pull = spawnSync('ollama', ['pull', baseTag], { stdio: 'inherit' });
    if (pull.status !== 0) {
      console.log(c.red('Failed to pull model via Ollama.'));
      return false;
    }
  }

  if (!quiet) console.log(c.cyan(`\nCreating tuned model "${profile.tunedModelName}"...`));
  const create = spawnSync('ollama', ['create', profile.tunedModelName, '-f', modelfilePath], {
    stdio: quiet ? 'pipe' : 'inherit',
  });
  if (create.status !== 0) {
    if (!quiet) console.log(c.red('Failed to create tuned Ollama model.'));
    return false;
  }

  saveSelfHostedRuntimeConfig({
    selfHostedModel: profile.tunedModelName,
    inferenceMode: 'auto',
  });

  if (!quiet) {
    console.log(c.green(`\n✓ Tuned model "${profile.tunedModelName}" is active and saved.`));
    console.log('');
  }
  return true;
}

export async function startOllamaDaemonIfNeeded(baseUrl: string): Promise<boolean> {
  const initial = await listOllamaModels(baseUrl);
  if (initial.reachable) return true;

  const cli = checkOllamaCli();
  if (!cli.installed) return false;

  console.log(c.slate('Starting local Ollama engine automatically...'));
  try {
    const child = spawn('ollama', ['serve'], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        OLLAMA_KEEP_ALIVE: process.env.OLLAMA_KEEP_ALIVE || '30m',
        OLLAMA_NUM_PARALLEL: process.env.OLLAMA_NUM_PARALLEL || '1',
      },
    });
    child.unref();
  } catch {
    return false;
  }

  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const check = await listOllamaModels(baseUrl);
    if (check.reachable) return true;
  }
  return false;
}

async function promptAutoInstallOllama(): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const cmdHint =
    process.platform === 'win32'
      ? 'winget install --id Ollama.Ollama -e --accept-source-agreements --accept-package-agreements'
      : process.platform === 'darwin'
        ? 'brew install ollama'
        : 'curl -fsSL https://ollama.com/install.sh | sh';

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(c.amber('\nOllama is required to run open-weight Qwen models locally ($0/month).'));
    const ans = await rl.question(
      `${c.bold(`Install Ollama automatically now via \`${cmdHint.split(' ')[0]}\`?`)} ${c.slate('[Y/n]')} `
    );
    const norm = ans.trim().toLowerCase();
    if (norm === 'n' || norm === 'no') return false;
  } finally {
    rl.close();
  }

  if (process.platform === 'win32') {
    const res = spawnSync(
      'winget',
      ['install', '--id', 'Ollama.Ollama', '-e', '--accept-source-agreements', '--accept-package-agreements'],
      { stdio: 'inherit' }
    );
    return res.status === 0;
  }
  if (process.platform === 'darwin') {
    const res = spawnSync('brew', ['install', 'ollama'], { stdio: 'inherit' });
    return res.status === 0;
  }
  const res = spawnSync('/bin/sh', ['-c', 'curl -fsSL https://ollama.com/install.sh | sh'], {
    stdio: 'inherit',
  });
  return res.status === 0;
}

/**
 * Ensures local Qwen inference is ready with ZERO manual server/setup commands:
 * 1) Auto-starts `ollama serve` in background if installed but offline.
 * 2) Auto-creates `codiz-local` tuned for the user's CPU/RAM/HDD if missing.
 * 3) Pre-warms weights in RAM (non-blocking) to avoid HDD stalls on first prompt.
 */
export async function ensureLocalRuntimeReady(options?: {
  allowInteractiveInstall?: boolean;
}): Promise<{ ready: boolean; modelName: string }> {
  const env = getEnv();
  const profile = detectMachineProfile();
  const runtimeCfg = getSelfHostedRuntimeConfig();

  let online = await startOllamaDaemonIfNeeded(runtimeCfg.selfHostedBaseUrl);

  if (!online && !checkOllamaCli().installed && options?.allowInteractiveInstall) {
    const installed = await promptAutoInstallOllama();
    if (installed) {
      online = await startOllamaDaemonIfNeeded(runtimeCfg.selfHostedBaseUrl);
    }
  }

  if (!online) {
    return { ready: false, modelName: runtimeCfg.selfHostedModel };
  }

  const status = await listOllamaModels(runtimeCfg.selfHostedBaseUrl);
  const hasTuned = status.models.some((m) => m === profile.tunedModelName || m.startsWith(`${profile.tunedModelName}:`));

  if (hasTuned) {
    if (runtimeCfg.selfHostedModel !== profile.tunedModelName) {
      saveSelfHostedRuntimeConfig({ selfHostedModel: profile.tunedModelName });
    }
    warmOllamaModel(runtimeCfg.selfHostedBaseUrl, profile.tunedModelName);
    return { ready: true, modelName: profile.tunedModelName };
  }

  // If user already has a Qwen model pulled, tune `codiz-local` around it in <1s without re-downloading
  const existingQwen = status.models.find((m) => /qwen/i.test(m));
  const tunedOk = await runTuneCommand(existingQwen || profile.recommendedBaseTag, Boolean(existingQwen));
  const activeModel = tunedOk ? profile.tunedModelName : existingQwen || env.LOCAL_LLM_MODEL;

  if (tunedOk || existingQwen) {
    warmOllamaModel(runtimeCfg.selfHostedBaseUrl, activeModel);
    return { ready: true, modelName: activeModel };
  }

  return { ready: false, modelName: runtimeCfg.selfHostedModel };
}

export function warmOllamaModel(baseUrl: string, model: string): void {
  const root = baseUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
  fetch(`${root}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: '', keep_alive: '30m' }),
  }).catch(() => null);
}
