# Codiz — Low-Resource Agentic Coding CLI & Self-Hosted Qwen Platform

**Codiz** is a subscription-free, low-resource AI coding agent built for **offline local development ($0/month)** on everyday hardware—including older CPU-only PCs (e.g., Intel i3-2120, 12 GB RAM, HDD, Windows/Linux)—with an optional scale-to-zero **Google Cloud Run** deployment path (<$20/month) and a standalone **VS Code extension (`vscode-extension/`)**.

---

## Quick Start: Push to GitHub → Clone → Run `codiz`

### 1. Clone, Install & Run (Zero Manual Setup)

```bash
git clone <YOUR_GITHUB_REPO_URL> codiz
cd codiz
npm install
npm link
codiz
```

What happens automatically—**without running a separate web server or manual config**:
1. `npm install` automatically builds the fast standalone CLI bundle (`dist-cli/codiz.mjs`, `<100ms` cold start on HDD) and generates a hardware-tuned `.env`.
2. Running `codiz` automatically detects your CPU/RAM (e.g., `i3-2120`, 2 threads, 4096 context, `qwen2.5-coder:1.5b-instruct-q4_K_M`), starts `ollama serve` in the background if needed, creates `codiz-local`, pins weights in RAM for 30 minutes (`keep_alive: 30m` on `/api/chat`), and opens the Muse-Code-style interactive terminal.

You can also run one-shot local commands directly in any folder:

```bash
codiz chat -p "write a python function"
codiz "inspect @src/server/app.ts for security issues"
```

Open **any** project directory and type:

```bash
codiz
```

This opens a Muse-Code-style bordered multi-line terminal prompt with:
- **Real CLI Coding Tools (mid-loop execution)**: `list_files`, `grep_search`, `read_file`, `write_file`, `edit_file`, and `run_command` (`npm install`, `npm test`, `python`, `tsc`, `git`) with real `stdout`/`stderr` feedback so the agent sees errors and fixes them.
- **Live Web Search & Web Scraping**: `web_search` and `web_scrape` (with SSRF & `robots.txt` protection) so the local Qwen model can look up live documentation and packages.
- **Fine-Tuned Local Qwen CLI Agent**: Built-in `codiz finetune` exports ChatML tool-calling QLoRA splits (`train.jsonl` / `val.jsonl`), and `codiz-local` specializes Qwen for low-resource CLI tool use.
- **Multi-line & `@file` Autocomplete**: `Alt+Enter`/`Ctrl+J` newlines, `@file` + `Tab` pinning, and interactive `[y]es / [n]o / [a]ll` approvals (or `--yes` / `/yolo`).

#### Useful CLI Commands
- `codiz` — Launch interactive coding terminal (auto-starts local Ollama + `codiz-local`)
- `codiz chat -p "write a python function"` — One-shot local execution
- `codiz -y "create a Hono hello-world script and test it with tsx"` — Run with auto-approved file/command steps
- `codiz finetune` — Export QLoRA tool-calling dataset for local Qwen fine-tuning
- `codiz doctor` — Hardware & Ollama diagnostics
- `codiz index` — Index workspace symbols & check file count
- `codiz serve` — Launch optional Web Dashboard + VS Code `/api/v1/chat/completions` server on port `3000`

#### Interactive Slash Commands
- `/search <query>` — Live web search
- `/web <url>` — Scrape & extract text + code blocks from a URL
- `/run <cmd>` — Execute a workspace shell command directly
- `/read <path>` / `/eval <path>` / `/docs <query>`
- `/yolo` — Toggle session auto-approve for writes & commands
- `/finetune` / `/mode <name>` / `/model [tag]` / `/clear` / `/serve` / `/exit`

---

## Hardware Profiles & Performance

| Profile | Target Hardware | Model | RAM Used | CPU Speed |
| :--- | :--- | :--- | :--- | :--- |
| `feather-cpu` | Intel i3-2120 (2c/4t), 8–12 GB RAM, HDD | `qwen2.5-coder:1.5b-instruct-q4_K_M` | ~1.4 GB | ~6–10 tok/s |
| `lite-cpu` | 6–8 thread CPU, 12+ GB RAM | `qwen2.5-coder:3b-instruct-q4_K_M` | ~2.4 GB | ~4–8 tok/s |
| `core-balanced` | 8+ threads or GPU, 16+ GB RAM | `qwen3:4b-q4_K_M` | ~3.4 GB | ~10–40 tok/s |

*(QLoRA fine-tuning in `ml_services/training/train_lora.py` requires CUDA VRAM and runs on Cloud Run L4 / Colab / Kaggle, exporting adapters back to local Ollama.)*

---

## Web Dashboard, VS Code Extension & Cloud Run

- **Web Workbench & Model Factory**: `npm run dev` (or `codiz serve`) on `http://localhost:3000`.
- **VS Code Extension**: Located in `vscode-extension/` — connects to `/api/v1/chat/completions` using `vscode.SecretStorage`.
- **Cloud Run Scale-to-Zero (<$20/mo)**:
  ```bash
  ./deploy/setup-gcp-iam.sh <GCP_PROJECT_ID> <GCS_BUCKET_NAME> europe-west1
  ./deploy/deploy-cloudrun.sh <GCP_PROJECT_ID> <GCS_BUCKET_NAME> europe-west1
  ```

---

## Verification

```bash
npm run lint
npm test
npm run build
```

See `docs/API.md` for REST endpoints and `PROJECT_MANIFEST.md` for architecture notes.
