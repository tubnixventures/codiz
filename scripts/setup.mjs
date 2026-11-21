import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

console.log('\nCodiz Local Setup (GitHub Clone -> Ready to Code)\n' + '─'.repeat(54));

// 1. Build fast CLI bundle (<100ms startup)
const buildScript = path.join(rootDir, 'scripts', 'build-cli-safe.mjs');
spawnSync(process.execPath, [buildScript], { cwd: rootDir, stdio: 'inherit' });

// 2. Detect hardware profile
const cpus = os.cpus();
const cpuModel = cpus[0]?.model?.trim() || 'CPU';
const logicalCores = Math.max(1, cpus.length);
const totalRamGb = Number((os.totalmem() / (1024 ** 3)).toFixed(1));
const isLowCoreCpu =
  logicalCores <= 4 || /\bi3-2\d{3}\b|\bi3-3\d{3}\b|\bPentium\b|\bCeleron\b/i.test(cpuModel);

const recommendedModel = isLowCoreCpu
  ? 'qwen2.5-coder:1.5b-instruct-q4_K_M'
  : logicalCores <= 8 || totalRamGb < 16
    ? 'qwen2.5-coder:3b-instruct-q4_K_M'
    : 'qwen3:4b-q4_K_M';

console.log(`Detected CPU: ${cpuModel} (${logicalCores} threads, ${totalRamGb} GB RAM)`);
console.log(`Recommended local Qwen model: ${recommendedModel}`);

// 3. Create .env from .env.example if missing
const envPath = path.join(rootDir, '.env');
const examplePath = path.join(rootDir, '.env.example');
if (!fs.existsSync(envPath) && fs.existsSync(examplePath)) {
  let content = fs.readFileSync(examplePath, 'utf8');
  content = content.replace(
    /LOCAL_LLM_MODEL="[^"]*"/,
    `LOCAL_LLM_MODEL="${recommendedModel}"`
  );
  if (isLowCoreCpu && !content.includes('CODIZ_LOW_RESOURCE=')) {
    content += '\nCODIZ_LOW_RESOURCE="true"\n';
  }
  fs.writeFileSync(envPath, content, 'utf8');
  console.log('✓ Created .env pre-tuned for this machine');
} else {
  console.log('• Kept existing .env');
}

// 4. Link global `codiz` command
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const linkRes = spawnSync(npmCmd, ['link'], {
  cwd: rootDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (linkRes.status === 0) {
  console.log('✓ Linked global `codiz` command');
} else {
  console.log('! Could not run `npm link` automatically (run with sudo or Administrator prompt if desired, or use `npm run codiz`).');
}

console.log('\nNext commands:');
console.log('  1. codiz doctor   # verify Ollama & PC hardware');
console.log('  2. codiz tune     # pull & optimize Qwen for your CPU/RAM');
console.log('  3. codiz          # launch interactive Muse-Code terminal\n');
