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
- **Multi-line editing**: `Alt+Enter`, `Ctrl+J`, or trailing `\` + `Enter` (paste-safe with bracketed paste).
- **`@file` & `/command` Tab autocomplete**: Type `@src/` + `Tab` to pin files or `/` + `Tab` for commands.
- **Multi-step agentic tool loop (max 5 steps)**: `repo_index`, `read_file`, `search_repo_context`, `search_documentation`, `evaluate_code`, `propose_file_write`, and `propose_command`.
- **Human-in-the-loop terminal diff approvals**: Inspect colored `+`/`-` diffs and approve `[y/N]` before Codiz writes files or runs shell commands.

#### Useful CLI Commands
- `codiz` — Launch interactive coding terminal
- `codiz "fix the validation bug in @src/server/app.ts"` — One-shot agentic task
- `codiz doctor` — Hardware & Ollama diagnostics
- `codiz tune` — Create CPU/RAM-optimized `codiz-local` model
- `codiz index` — Index workspace symbols & check file count
- `codiz serve` — Launch the full Web Workbench UI + Hono API + VS Code `/api/v1/chat/completions` server on port `3000`

#### Interactive Slash Commands
- `/mode <autonomous|debugging|chat|review|architecture|completion>`
- `/model [tag]` — Inspect or switch active local Qwen model
- `/read <path>` — Pin a file into conversation context
- `/eval <path>` — Run TypeScript syntax & security smell check on a file
- `/search <query>` — Search the 20-collection Knowledge RAG store
- `/approve` — Review pending file writes / command proposals
- `/clear` — Start a fresh conversation
- `/serve` — Launch Web Dashboard + VS Code API gateway
- `/exit`

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
