import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

// Ensure .env exists right after `npm install` with CPU/RAM-appropriate defaults
const envPath = path.join(rootDir, '.env');
const examplePath = path.join(rootDir, '.env.example');
if (!fs.existsSync(envPath) && fs.existsSync(examplePath)) {
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model?.trim() || 'CPU';
  const logicalCores = Math.max(1, cpus.length);
  const totalRamGb = os.totalmem() / (1024 ** 3);
  const isLowCoreCpu =
    logicalCores <= 4 || /\bi3-2\d{3}\b|\bi3-3\d{3}\b|\bPentium\b|\bCeleron\b/i.test(cpuModel);
  const recommendedModel = isLowCoreCpu
    ? 'qwen2.5-coder:1.5b-instruct-q4_K_M'
    : logicalCores <= 8 || totalRamGb < 16
      ? 'qwen2.5-coder:3b-instruct-q4_K_M'
      : 'qwen3:4b-q4_K_M';

  let content = fs.readFileSync(examplePath, 'utf8');
  content = content.replace(/LOCAL_LLM_MODEL="[^"]*"/, `LOCAL_LLM_MODEL="${recommendedModel}"`);
  if (isLowCoreCpu && !content.includes('CODIZ_LOW_RESOURCE=')) {
    content += '\nCODIZ_LOW_RESOURCE="true"\n';
  }
  fs.writeFileSync(envPath, content, 'utf8');
}

// Ensure esbuild is available before building CLI bundle (safe during partial installs)
const esbuildBin = path.join(
  rootDir,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild'
);

if (!fs.existsSync(esbuildBin)) {
  process.exit(0);
}

fs.mkdirSync(path.join(rootDir, 'dist-cli'), { recursive: true });
const res = spawnSync(
  esbuildBin,
  [
    'src/cli/index.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--packages=external',
    '--outfile=dist-cli/codiz.mjs',
  ],
  {
    cwd: rootDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  }
);

if (res.status !== 0) {
  console.warn('Note: CLI bundle build skipped; bin/codiz.mjs will run via tsx fallback.');
}
process.exit(0);
