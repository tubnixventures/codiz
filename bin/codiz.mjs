#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const bundledCli = path.join(rootDir, 'dist-cli', 'codiz.mjs');
const sourceCli = path.join(rootDir, 'src', 'cli', 'index.ts');

if (fs.existsSync(bundledCli)) {
  await import(pathToFileURL(bundledCli).href);
} else {
  const tsxBin = path.join(
    rootDir,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsx.cmd' : 'tsx'
  );
  const runner = fs.existsSync(tsxBin) ? tsxBin : 'npx';
  const args = fs.existsSync(tsxBin)
    ? [sourceCli, ...process.argv.slice(2)]
    : ['tsx', sourceCli, ...process.argv.slice(2)];

  const res = spawnSync(runner, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  process.exit(res.status ?? 0);
}
