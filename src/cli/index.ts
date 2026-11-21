import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { getEnv, resetEnvCache } from '../server/config/env.ts';
import {
  getSelfHostedRuntimeConfig,
  saveSelfHostedRuntimeConfig,
} from '../server/config/runtime.ts';
import { closeDb } from '../server/db/sqlite.ts';
import { probeInferenceBackends } from '../server/providers/llm/router.ts';
import { runAgentTurn } from '../server/services/agent/orchestrator.ts';
import { evaluateCodeSnippet } from '../server/services/evaluator/runner.ts';
import {
  indexWorkspaceRepository,
  resolveSafeWorkspacePath,
} from '../server/services/repository/indexer.ts';
import { searchKnowledge } from '../server/services/retrieval/knowledge.ts';
import type { AgentMode } from '../server/types/domain.ts';
import { c, renderMarkdownToTerminal, Spinner } from './ansi.ts';
import { reviewPendingApprovals } from './approvals.ts';
import {
  detectMachineProfile,
  ensureLocalRuntimeReady,
  runDoctorCommand,
  runTuneCommand,
} from './hardware.ts';
import { promptMuseTextArea } from './textarea.ts';

const VALID_MODES: AgentMode[] = [
  'autonomous',
  'debugging',
  'chat',
  'completion',
  'architecture',
  'review',
];

function bootstrapCliEnv(explicitWorkspace?: string): { repoRoot: string; dataDir: string } {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(__dirname, '..', '..');
  const cwd = path.resolve(explicitWorkspace || process.cwd());

  const cwdEnv = path.join(cwd, '.env');
  const repoEnv = path.join(repoRoot, '.env');
  if (fs.existsSync(cwdEnv)) dotenv.config({ path: cwdEnv, quiet: true });
  else if (fs.existsSync(repoEnv)) dotenv.config({ path: repoEnv, quiet: true });

  process.env.CODIZ_WORKSPACE_ROOT = cwd;
  if (!process.env.CODIZ_DATA_DIR) {
    const localDataDir = path.join(cwd, '.codiz-data');
    process.env.CODIZ_DATA_DIR = fs.existsSync(localDataDir)
      ? localDataDir
      : path.join(os.homedir(), '.codiz');
  }
  resetEnvCache();
  return { repoRoot, dataDir: getEnv().CODIZ_DATA_DIR };
}

function printHelp(): void {
  console.log(`
${c.bold(c.emerald('Codiz CLI'))} — Low-resource agentic coding assistant (Self-Hosted Qwen + Muse Code TUI)

${c.bold('Usage:')}
  codiz                     Launch interactive Muse-Code-style coding terminal (auto-starts local Qwen)
  codiz "<prompt>"          Run a single local agentic task and exit
  codiz chat -p "<prompt>"  Run a local prompt directly without starting any web server
  codiz doctor              Inspect CPU/RAM, Ollama status, and optimal local Qwen profile
  codiz tune [base-tag]     Create CPU/HDD-tuned "codiz-local" Ollama model for this machine
  codiz index               Index the current project and show file/symbol summary
  codiz serve               Start the optional Web Dashboard + Hono API + VS Code server

${c.bold('Options:')}
  -p, --prompt <text>       Prompt text for one-shot local execution
  --mode <mode>             autonomous | debugging | chat | review | architecture | completion
  --model <tag>             Override Ollama/vLLM model tag for this session
  --provider <name>         auto | local-ollama | vllm | gemini
  --no-agent                Use fast single-turn completion instead of multi-step tool loop
  --no-auto-start           Do not auto-launch Ollama daemon
  -w, --workspace <dir>     Target workspace directory (defaults to current folder)
  -v, --version             Print version
  -h, --help                Show help

${c.bold('Interactive Slash Commands:')}
  /mode <name>  /model [tag]  /read <file>  /search <query>  /eval <file>
  /index        /approve      /doctor       /tune            /clear
  /serve        /help         /exit
`);
}

function extractMentionedFiles(text: string, repoFiles: string[]): string[] {
  const matches = text.match(/@([a-zA-Z0-9_./-]+)/g) ?? [];
  const fileSet = new Set(repoFiles);
  const found: string[] = [];
  for (const m of matches) {
    const candidate = m.slice(1);
    if (fileSet.has(candidate)) found.push(candidate);
  }
  return found;
}

async function runSingleTurn(params: {
  prompt: string;
  conversationId?: string;
  mode: AgentMode;
  agentic: boolean;
  compactMode: boolean;
  preferProvider: 'auto' | 'local-ollama' | 'vllm' | 'gemini';
  pinnedFiles: string[];
}): Promise<{ conversationId: string }> {
  const snap = indexWorkspaceRepository();
  const mentioned = extractMentionedFiles(params.prompt, snap.files.map((f) => f.relativePath));
  const explicitFiles = Array.from(new Set([...params.pinnedFiles, ...mentioned]));

  const spinner = new Spinner();
  let streamedDirect = false;
  let printedStreamHeader = false;

  spinner.start(params.agentic ? 'Agent planning step 1/5' : 'Thinking');

  try {
    const res = await runAgentTurn({
      conversationId: params.conversationId,
      prompt: params.prompt,
      mode: params.mode,
      agentic: params.agentic,
      compactMode: params.compactMode,
      explicitFiles,
      preferProvider: params.preferProvider,
      useRepoContext: true,
      useKnowledgeRag: true,
      onStepStart: (step, maxSteps) => {
        spinner.update(
          params.agentic
            ? `Agent reasoning step ${step}/${maxSteps}`
            : 'Generating response'
        );
      },
      onToolEvent: (trace) => {
        if (trace.step === 0) return;
        spinner.stop();
        const icon = trace.ok ? c.green('✓') : c.amber('!');
        console.log(
          `  ${icon} ${c.cyan(`[step ${trace.step}]`)} ${c.bold(trace.tool)} ${c.slate('—')} ${c.slate(trace.summary)}`
        );
        if (trace.tool !== 'final_answer') {
          spinner.start(`Agent evaluating observation (${trace.tool})`);
        }
      },
      onToken: !params.agentic
        ? (delta) => {
            if (!printedStreamHeader) {
              spinner.stop();
              console.log('');
              printedStreamHeader = true;
            }
            streamedDirect = true;
            process.stdout.write(delta);
          }
        : undefined,
    });

    spinner.stop();

    if (streamedDirect) {
      console.log('\n');
    } else {
      console.log('');
      console.log(renderMarkdownToTerminal(res.reply));
      console.log('');
    }

    const secs = (res.latencyMs / 1000).toFixed(1);
    const costLabel =
      res.estimatedCostUsd === 0 ? c.emerald('$0.00 (self-hosted)') : c.amber(`$${res.estimatedCostUsd.toFixed(5)}`);
    console.log(
      c.slate(
        `  [${res.providerUsed}:${res.modelId} · ${res.tokensIn} in / ${res.tokensOut} out · ${secs}s · `
      ) +
        costLabel +
        c.slate(']')
    );
    console.log('');

    if (res.pendingApprovalIds.length > 0) {
      await reviewPendingApprovals(res.pendingApprovalIds);
    }

    return { conversationId: res.conversationId };
  } catch (err) {
    spinner.stop();
    console.log('');
    console.log(c.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
    console.log(
      c.slate('Tip: run `codiz doctor` to check Ollama/Qwen or `codiz tune` to pull and configure local Qwen 1.5B.')
    );
    console.log('');
    return { conversationId: params.conversationId ?? '' };
  }
}

function launchWebServer(repoRoot: string): void {
  const serverEntry = path.join(repoRoot, 'server.ts');
  const tsxBin = path.join(
    repoRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsx.cmd' : 'tsx'
  );
  console.log(c.emerald('Starting Codiz Web Dashboard & Hono API on http://127.0.0.1:3000 ...'));
  const child = fs.existsSync(tsxBin)
    ? spawn(tsxBin, [serverEntry], { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' })
    : spawn('npx', ['tsx', serverEntry], { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' });
  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });
}

async function runInteractiveSession(opts: {
  repoRoot: string;
  dataDir: string;
  initialMode: AgentMode;
  agentic: boolean;
  preferProvider: 'auto' | 'local-ollama' | 'vllm' | 'gemini';
}): Promise<void> {
  const profile = detectMachineProfile();
  const runtimeCfg = getSelfHostedRuntimeConfig();
  const probe = await probeInferenceBackends();
  const initialSnap = indexWorkspaceRepository();

  let mode: AgentMode = opts.initialMode;
  let agentic = opts.agentic;
  const preferProvider = opts.preferProvider;
  let conversationId: string | undefined;
  let pinnedFiles: string[] = [];
  const historyFile = path.join(opts.dataDir, 'cli-history.json');

  console.log('');
  console.log(
    `${c.bold(c.emerald('CODIZ'))} ${c.slate('v1.0.0')}  ${c.slate('·')}  ${c.white(initialSnap.rootName)} ${c.slate(`(${initialSnap.totalFiles} files)`)}`
  );
  console.log(
    `  Backend:  ${probe.localOllamaReachable || probe.vllmReachable || probe.geminiConfigured ? c.cyan(probe.activeDefault) : c.amber('No model server online — run `codiz tune` or start Ollama')}`
  );
  console.log(
    `  Hardware: ${c.slate(`${profile.cpuModel} · ${profile.totalRamGb}GB RAM · profile=${profile.tierName} (threads=${profile.recommendedThreads}, ctx=${profile.recommendedCtx})`)}`
  );
  console.log(
    `  Tip:      ${c.slate('Type @file to attach code, /help for commands, Alt/Ctrl+J for multi-line')}`
  );
  console.log('');

  while (true) {
    const activeRuntime = getSelfHostedRuntimeConfig();
    const modelLabel =
      preferProvider === 'gemini'
        ? 'gemini-4-hydrogen'
        : activeRuntime.selfHostedModel || runtimeCfg.selfHostedModel;

    const input = await promptMuseTextArea({
      mode: agentic ? mode : `${mode}:fast`,
      modelLabel,
      workspaceName: initialSnap.rootName,
      historyFile,
      getWorkspaceFiles: () => indexWorkspaceRepository().files.map((f) => f.relativePath),
    });

    if (input === null) {
      console.log(c.slate('\nSession closed.'));
      break;
    }

    const trimmed = input.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('/')) {
      const [rawCmd, ...rest] = trimmed.split(/\s+/);
      const cmd = rawCmd.toLowerCase();
      const arg = rest.join(' ').trim();

      if (cmd === '/exit' || cmd === '/quit') {
        console.log(c.slate('Goodbye.'));
        break;
      }
      if (cmd === '/help') {
        printHelp();
        continue;
      }
      if (cmd === '/clear') {
        conversationId = undefined;
        pinnedFiles = [];
        console.log(c.green('✓ Started fresh conversation & cleared pinned files.\n'));
        continue;
      }
      if (cmd === '/mode') {
        if (!arg) {
          console.log(`Current mode: ${c.cyan(mode)} (available: ${VALID_MODES.join(', ')})\n`);
        } else if (VALID_MODES.includes(arg as AgentMode)) {
          mode = arg as AgentMode;
          agentic = mode === 'autonomous' || mode === 'debugging';
          console.log(c.green(`✓ Switched mode to ${mode} (agent loop=${agentic})\n`));
        } else {
          console.log(c.amber(`Unknown mode "${arg}". Choose: ${VALID_MODES.join(', ')}\n`));
        }
        continue;
      }
      if (cmd === '/model') {
        if (!arg) {
          const cur = getSelfHostedRuntimeConfig();
          console.log(`Active self-hosted model: ${c.cyan(cur.selfHostedModel)} (${cur.selfHostedBaseUrl})\n`);
        } else {
          saveSelfHostedRuntimeConfig({ selfHostedModel: arg });
          console.log(c.green(`✓ Switched active model to ${arg}\n`));
        }
        continue;
      }
      if (cmd === '/doctor') {
        await runDoctorCommand();
        continue;
      }
      if (cmd === '/tune') {
        await runTuneCommand(arg || undefined);
        continue;
      }
      if (cmd === '/index') {
        const snap = indexWorkspaceRepository(true);
        console.log(
          c.green(`✓ Indexed ${snap.totalFiles} files (${snap.totalLines} lines) in ${snap.rootName}`)
        );
        console.log(c.slate(`  Languages: ${JSON.stringify(snap.languages)}\n`));
        continue;
      }
      if (cmd === '/read') {
        if (!arg) {
          console.log(
            pinnedFiles.length
              ? `Pinned files: ${pinnedFiles.join(', ')}\n`
              : c.slate('Usage: /read <relative/path>\n')
          );
        } else {
          try {
            const safe = resolveSafeWorkspacePath(arg);
            if (!fs.existsSync(safe)) {
              console.log(c.red(`File not found: ${arg}\n`));
            } else {
              if (!pinnedFiles.includes(arg)) pinnedFiles.push(arg);
              console.log(c.green(`✓ Pinned ${arg} into conversation context.\n`));
            }
          } catch (err) {
            console.log(c.red(`${err instanceof Error ? err.message : String(err)}\n`));
          }
        }
        continue;
      }
      if (cmd === '/search') {
        if (!arg) {
          console.log(c.slate('Usage: /search <query>\n'));
        } else {
          const hits = searchKnowledge(arg, undefined, 4);
          if (hits.length === 0) {
            console.log(c.slate('No matching knowledge docs found.\n'));
          } else {
            hits.forEach((h) => {
              console.log(`  ${c.cyan(`[${h.collection}]`)} ${c.bold(h.title)}`);
              console.log(`  ${c.slate(h.content.slice(0, 180))}...\n`);
            });
          }
        }
        continue;
      }
      if (cmd === '/eval') {
        if (!arg) {
          console.log(c.slate('Usage: /eval <relative/path>\n'));
        } else {
          try {
            const safe = resolveSafeWorkspacePath(arg);
            const code = fs.readFileSync(safe, 'utf8');
            const lang = arg.endsWith('.py') ? 'python' : arg.match(/\.(ts|tsx|js|jsx|mjs)$/) ? 'typescript' : 'other';
            const report = evaluateCodeSnippet(code, lang);
            console.log(
              `  Syntax: ${report.syntaxValid ? c.green('PASS') : c.red('FAIL')} · Maintainability: ${c.cyan(String(report.maintainabilityScore))}/100`
            );
            if (report.diagnostics.length) console.log(c.red(`  Diagnostics: ${report.diagnostics.join(' | ')}`));
            if (report.securityIssues.length)
              console.log(c.amber(`  Security notes: ${report.securityIssues.join(' | ')}`));
            console.log('');
          } catch (err) {
            console.log(c.red(`${err instanceof Error ? err.message : String(err)}\n`));
          }
        }
        continue;
      }
      if (cmd === '/approve') {
        const count = await reviewPendingApprovals();
        if (count === 0) console.log(c.slate('No pending approvals.\n'));
        continue;
      }
      if (cmd === '/serve') {
        launchWebServer(opts.repoRoot);
        return;
      }

      console.log(c.amber(`Unknown command "${cmd}". Type /help to see commands.\n`));
      continue;
    }

    const res = await runSingleTurn({
      prompt: trimmed,
      conversationId,
      mode,
      agentic,
      compactMode: profile.compactPromptDefault,
      preferProvider,
      pinnedFiles,
    });
    if (res.conversationId) {
      conversationId = res.conversationId;
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let mode: AgentMode = 'autonomous';
  let agentic = true;
  let autoStart = true;
  let modelOverride: string | undefined;
  let promptFlag: string | undefined;
  let preferProvider: 'auto' | 'local-ollama' | 'vllm' | 'gemini' = 'auto';
  let workspaceArg: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') {
      printHelp();
      return;
    }
    if (a === '-v' || a === '--version') {
      console.log('codiz v1.0.0');
      return;
    }
    if (a === '--no-agent') {
      agentic = false;
      continue;
    }
    if (a === '--no-auto-start') {
      autoStart = false;
      continue;
    }
    if ((a === '-p' || a === '--prompt') && args[i + 1]) {
      promptFlag = args[++i];
      continue;
    }
    if (a === '--mode' && args[i + 1]) {
      const m = args[++i] as AgentMode;
      if (VALID_MODES.includes(m)) mode = m;
      continue;
    }
    if (a === '--model' && args[i + 1]) {
      modelOverride = args[++i];
      continue;
    }
    if (a === '--provider' && args[i + 1]) {
      const p = args[++i];
      if (p === 'auto' || p === 'local-ollama' || p === 'vllm' || p === 'gemini') {
        preferProvider = p;
      }
      continue;
    }
    if ((a === '-w' || a === '--workspace') && args[i + 1]) {
      workspaceArg = args[++i];
      continue;
    }
    positional.push(a);
  }

  const { repoRoot, dataDir } = bootstrapCliEnv(workspaceArg);
  if (modelOverride) {
    saveSelfHostedRuntimeConfig({ selfHostedModel: modelOverride });
  }

  const subcommand = positional[0]?.toLowerCase();

  try {
    if (subcommand === 'doctor') {
      await runDoctorCommand();
      return;
    }
    if (subcommand === 'tune') {
      await runTuneCommand(positional[1]);
      return;
    }
    if (subcommand === 'index') {
      const snap = indexWorkspaceRepository(true);
      console.log(
        c.green(`Indexed ${snap.totalFiles} files (${snap.totalLines} lines) in ${snap.rootName}`)
      );
      console.log(JSON.stringify(snap.languages, null, 2));
      return;
    }
    if (subcommand === 'serve') {
      launchWebServer(repoRoot);
      return;
    }

    // Zero-manual local startup: auto-launch Ollama & tune `codiz-local` if needed
    if (autoStart && (preferProvider === 'auto' || preferProvider === 'local-ollama')) {
      await ensureLocalRuntimeReady({ allowInteractiveInstall: subcommand !== 'chat' && !promptFlag });
    }

    if (subcommand === 'chat') {
      const chatPrompt = promptFlag || positional.slice(1).join(' ').trim();
      if (chatPrompt) {
        const profile = detectMachineProfile();
        await runSingleTurn({
          prompt: chatPrompt,
          mode,
          agentic,
          compactMode: profile.compactPromptDefault,
          preferProvider,
          pinnedFiles: [],
        });
        return;
      }
    } else if (promptFlag || positional.length > 0) {
      const profile = detectMachineProfile();
      await runSingleTurn({
        prompt: promptFlag || positional.join(' '),
        mode,
        agentic,
        compactMode: profile.compactPromptDefault,
        preferProvider,
        pinnedFiles: [],
      });
      return;
    }

    await runInteractiveSession({
      repoRoot,
      dataDir,
      initialMode: mode,
      agentic,
      preferProvider,
    });
  } finally {
    if (subcommand !== 'serve') {
      closeDb();
    }
  }
}

main().catch((err) => {
  console.error(c.red(`Fatal error: ${err instanceof Error ? err.message : String(err)}`));
  closeDb();
  process.exit(1);
});
