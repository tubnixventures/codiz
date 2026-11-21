import { spawn, spawnSync } from 'node:child_process';
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
import { validateProposedShellCommand } from '../server/services/agent/tools.ts';
import { evaluateCodeSnippet } from '../server/services/evaluator/runner.ts';
import {
  indexWorkspaceRepository,
  invalidateRepoIndexCache,
  resolveSafeWorkspacePath,
} from '../server/services/repository/indexer.ts';
import { searchKnowledge } from '../server/services/retrieval/knowledge.ts';
import {
  exportApprovedDatasetJsonl,
  seedCliAgentTrainingExamples,
} from '../server/services/teacher/factory.ts';
import { webScrape, webSearch } from '../server/services/web/research.ts';
import type { AgentMode } from '../server/types/domain.ts';
import { c, renderMarkdownToTerminal, Spinner } from './ansi.ts';
import {
  type CliApprovalState,
  confirmCliActionMidLoop,
  reviewPendingApprovals,
} from './approvals.ts';
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

function resolveCodizRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function bootstrapCliEnv(explicitWorkspace?: string): { repoRoot: string; dataDir: string } {
  const repoRoot = resolveCodizRepoRoot();
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
${c.bold(c.emerald('Codiz CLI'))} — Fine-tuned local CLI coding agent (files · npm/shell · live web search & scrape)

${c.bold('Usage:')}
  codiz                     Launch interactive Muse-Code-style coding terminal (auto-starts local Qwen)
  codiz "<prompt>"          Run a single local coding-agent task and exit
  codiz chat -p "<prompt>"  Run a local prompt directly without starting any web server
  codiz finetune            Export QLoRA tool-calling dataset (files, npm, web) for local Qwen fine-tuning
  codiz doctor              Inspect CPU/RAM, Ollama status, and optimal local Qwen profile
  codiz tune [base-tag]     Create CLI-agent-tuned "codiz-local" Ollama model for this machine
  codiz index               Index the current project and show file/symbol summary
  codiz serve               Start the optional Web Dashboard + Hono API + VS Code server

${c.bold('Options:')}
  -p, --prompt <text>       Prompt text for one-shot local execution
  -y, --yes                 Auto-approve workspace file writes and commands for this session
  --mode <mode>             autonomous | debugging | chat | review | architecture | completion
  --model <tag>             Override Ollama/vLLM model tag for this session
  --provider <name>         auto | local-ollama | vllm | gemini
  --no-agent                Use fast single-turn completion instead of multi-step tool loop
  --no-auto-start           Do not auto-launch Ollama daemon
  -w, --workspace <dir>     Target workspace directory (defaults to current folder)
  -v, --version             Print version
  -h, --help                Show help

${c.bold('Interactive Slash Commands:')}
  /search <query>           Live web search (DuckDuckGo)
  /web <url>                Live web scrape & code extraction from any public docs URL
  /run <command>            Execute a workspace shell command (e.g. npm test, npm install)
  /read <file>              Pin a workspace file into conversation context
  /eval <file>              Run static TypeScript/security diagnostics on a file
  /docs <query>             Search offline Knowledge RAG cache
  /yolo                     Toggle auto-approve for file writes & shell commands
  /finetune                 Seed & export CLI coding-agent QLoRA JSONL training split
  /mode <name>  /model [tag]  /index  /approve  /doctor  /tune  /clear  /serve  /exit
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

async function runFinetuneExport(repoRoot: string): Promise<void> {
  const seeded = seedCliAgentTrainingExamples();
  const dsVersion = `ds-cli-agent-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
  const exported = await exportApprovedDatasetJsonl(dsVersion);
  console.log('');
  console.log(c.bold(c.emerald('Codiz Local Coding-Agent Fine-Tuning Dataset Ready')));
  console.log(`  • CLI tool examples: ${seeded.inserted} new (${seeded.deduplicated} already present)`);
  console.log(`  • Exported JSONL:    ${exported.trainCount} train / ${exported.valCount} val`);
  console.log(`  • Train URI:         ${c.cyan(exported.trainUri)}`);
  console.log(`  • Val URI:           ${c.cyan(exported.valUri)}`);
  console.log(c.slate('  Next (on GPU / Colab / Cloud Run L4):'));
  console.log(
    c.white(`    python ${path.join(repoRoot, 'ml_services/training/train_lora.py')} --train "${exported.trainUri}" --val "${exported.valUri}"`)
  );
  console.log(c.slate('  Then convert/import your GGUF adapter locally via:'));
  console.log(c.white('    codiz tune <your-finetuned-gguf-tag>'));
  console.log('');
}

async function runSingleTurn(params: {
  prompt: string;
  conversationId?: string;
  mode: AgentMode;
  agentic: boolean;
  compactMode: boolean;
  preferProvider: 'auto' | 'local-ollama' | 'vllm' | 'gemini';
  pinnedFiles: string[];
  approvalState: CliApprovalState;
}): Promise<{ conversationId: string }> {
  const snap = indexWorkspaceRepository();
  const mentioned = extractMentionedFiles(params.prompt, snap.files.map((f) => f.relativePath));
  const explicitFiles = Array.from(new Set([...params.pinnedFiles, ...mentioned]));

  const spinner = new Spinner();
  let streamedDirect = false;
  let printedStreamHeader = false;

  spinner.start(params.agentic ? 'Agent planning step 1/8' : 'Thinking');

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
      onConfirmAction: async (req) => {
        spinner.stop();
        const ok = await confirmCliActionMidLoop(req, params.approvalState);
        spinner.start(
          req.kind === 'command'
            ? `Executing \`${req.command}\``
            : `Writing ${req.path}`
        );
        return ok;
      },
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
  autoYes: boolean;
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
  const approvalState: CliApprovalState = {
    autoApproveWrites: opts.autoYes,
    autoApproveCommands: opts.autoYes,
  };
  const historyFile = path.join(opts.dataDir, 'cli-history.json');

  console.log('');
  console.log(
    `${c.bold(c.emerald('CODIZ'))} ${c.slate('v1.0.0 CLI Agent')}  ${c.slate('·')}  ${c.white(initialSnap.rootName)} ${c.slate(`(${initialSnap.totalFiles} files)`)}`
  );
  console.log(
    `  Model:    ${probe.localOllamaReachable || probe.vllmReachable || probe.geminiConfigured ? c.cyan(probe.activeDefault) : c.amber('Local Ollama offline — install Ollama to run offline ($0/mo)')}`
  );
  console.log(
    `  Tools:    ${c.slate('files (read/write/edit/grep) · shell (npm/node/python/git) · live web_search & web_scrape')}`
  );
  console.log(
    `  Hardware: ${c.slate(`${profile.cpuModel} · ${profile.totalRamGb}GB RAM · ${profile.tierName} (threads=${profile.recommendedThreads}, ctx=${profile.recommendedCtx})`)}`
  );
  console.log(
    `  Tip:      ${c.slate('@file attaches code · /search queries web · /web <url> scrapes · /yolo auto-approves')}`
  );
  console.log('');

  while (true) {
    const activeRuntime = getSelfHostedRuntimeConfig();
    const modelLabel =
      preferProvider === 'gemini'
        ? 'gemini-4-hydrogen'
        : activeRuntime.selfHostedModel || runtimeCfg.selfHostedModel;

    const input = await promptMuseTextArea({
      mode: agentic ? (approvalState.autoApproveCommands ? `${mode}:auto` : mode) : `${mode}:fast`,
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
      if (cmd === '/yolo') {
        const next = !(approvalState.autoApproveWrites && approvalState.autoApproveCommands);
        approvalState.autoApproveWrites = next;
        approvalState.autoApproveCommands = next;
        console.log(
          next
            ? c.amber('⚡ Session auto-approve ON (file writes & safe shell commands run without prompt).\n')
            : c.green('✓ Session auto-approve OFF (interactive [y/n/a] prompts active).\n')
        );
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
      if (cmd === '/finetune') {
        await runFinetuneExport(opts.repoRoot);
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
          console.log(c.slate('Usage: /search <web query>\n'));
        } else {
          const spinner = new Spinner();
          spinner.start(`Searching web for "${arg}"`);
          const res = await webSearch(arg, 5);
          spinner.stop();
          if (res.results.length === 0) {
            console.log(c.amber(res.note || 'No live web results found.\n'));
          } else {
            res.results.forEach((r, idx) => {
              console.log(`  ${c.cyan(`${idx + 1}.`)} ${c.bold(r.title)}`);
              console.log(`     ${c.emerald(r.url)}`);
              if (r.snippet) console.log(`     ${c.slate(r.snippet)}`);
            });
            console.log('');
          }
        }
        continue;
      }
      if (cmd === '/web') {
        if (!arg) {
          console.log(c.slate('Usage: /web <https://url>\n'));
        } else {
          const spinner = new Spinner();
          spinner.start(`Scraping ${arg}`);
          try {
            const page = await webScrape(arg, 3000);
            spinner.stop();
            console.log(c.bold(c.emerald(`\n${page.title}`)));
            console.log(c.slate(`${page.url} (${page.charCount} chars)\n`));
            console.log(page.excerpt.slice(0, 1400));
            if (page.codeBlocks.length > 0) {
              console.log(c.cyan(`\nExtracted ${page.codeBlocks.length} code block(s). First block:`));
              console.log(c.slate(page.codeBlocks[0].slice(0, 600)));
            }
            console.log('');
          } catch (err) {
            spinner.stop();
            console.log(c.red(`${err instanceof Error ? err.message : String(err)}\n`));
          }
        }
        continue;
      }
      if (cmd === '/run') {
        if (!arg) {
          console.log(c.slate('Usage: /run <shell command>\n'));
        } else {
          try {
            validateProposedShellCommand(arg);
            const env = getEnv();
            const ok = await confirmCliActionMidLoop(
              { kind: 'command', command: arg, cwd: env.CODIZ_WORKSPACE_ROOT, reason: 'User /run command' },
              approvalState
            );
            if (ok) {
              const shellBin = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
              const shellArgs = process.platform === 'win32' ? ['/c', arg] : ['-c', arg];
              spawnSync(shellBin, shellArgs, {
                cwd: env.CODIZ_WORKSPACE_ROOT,
                stdio: 'inherit',
                timeout: 45_000,
              });
              invalidateRepoIndexCache();
            }
            console.log('');
          } catch (err) {
            console.log(c.red(`${err instanceof Error ? err.message : String(err)}\n`));
          }
        }
        continue;
      }
      if (cmd === '/docs') {
        if (!arg) {
          console.log(c.slate('Usage: /docs <query>\n'));
        } else {
          const hits = searchKnowledge(arg, undefined, 4);
          if (hits.length === 0) {
            console.log(c.slate('No matching offline docs found.\n'));
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
      approvalState,
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
  let autoYes = false;
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
    if (a === '-y' || a === '--yes') {
      autoYes = true;
      continue;
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
  const approvalState: CliApprovalState = {
    autoApproveWrites: autoYes,
    autoApproveCommands: autoYes,
  };

  try {
    if (subcommand === 'doctor') {
      await runDoctorCommand();
      return;
    }
    if (subcommand === 'tune') {
      await runTuneCommand(positional[1]);
      return;
    }
    if (subcommand === 'finetune') {
      await runFinetuneExport(repoRoot);
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
          approvalState,
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
        approvalState,
      });
      return;
    }

    await runInteractiveSession({
      repoRoot,
      dataDir,
      initialMode: mode,
      agentic,
      autoYes,
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
