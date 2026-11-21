# Codiz Hono API Reference

Base path: `/api`
Protected endpoints require `Authorization: Bearer <session_token>` (obtained via `/api/auth/bootstrap` or `/api/auth/login`, or static `CODIZ_API_TOKEN`).

## Health & Authentication
- `GET /api/health` — Database, active inference backend (`local-ollama`, `vllm`, `gemini`), and storage status.
- `GET /api/ready` & `GET /api/live` — Cloud Run readiness & liveness probes.
- `GET /api/auth/status` — Check whether workspace passphrase bootstrap is needed.
- `POST /api/auth/bootstrap` — One-time first-run workspace passphrase setup (`scrypt` hashed).
- `POST /api/auth/login` — Exchange passphrase or `CODIZ_API_TOKEN` for Bearer session token.

## Coding Agent & Repository Intelligence
- `POST /api/chat` — Run multi-mode coding agent (`chat | completion | debugging | architecture | review | autonomous`).
- `GET /api/chat/conversations` — List recent coding sessions.
- `POST /api/chat/feedback` — Submit thumbs up/down; positive replies auto-capture into scrubbed training dataset.
- `GET /api/repo/index` — Index workspace files, languages, and extracted symbols.
- `POST /api/repo/context` — Preview 4B token-budgeted context compression for a query.
- `GET /api/repo/approvals` & `POST /api/repo/approvals/:id` — Approve or reject sandboxed write proposals.

## Model Factory, Registry & Evaluation
- `GET /api/models` — List registered foundation + LoRA adapter versions.
- `GET /api/models/catalog` — List supported open-weight models (`Qwen3-4B`, `Qwen2.5-Coder-3B`, `7B`, `14B`) with RAM/VRAM specs.
- `GET /api/models/local-bundle?foundationId=...` — Generate Ollama `Modelfile` and `llama.cpp` commands.
- `POST /api/models/:id/evaluate` — Run automated TypeScript compiler, security, and benchmark checks.
- `POST /api/models/:id/promote` — Promote candidate to production (blocked if benchmark gate fails).
- `POST /api/models/rollback` — Immediately restore previous production model version.
- `POST /api/factory/muse-import` — Import authorized Muse Code JSONL with secret scrubbing and attribution.
- `POST /api/factory/synthetic` — Generate teacher-crafted training pairs.
- `POST /api/factory/examples/:id/teacher-review` — Run AI Teacher critique and code repair.
- `POST /api/factory/training/run` — Export train/val JSONL to GCS/local mirror and create QLoRA training manifest.

## Knowledge Engine & Budget
- `GET /api/knowledge/search?q=...&collection=...` — Hybrid search across 20 curated technical ecosystems.
- `POST /api/knowledge/ingest` & `POST /api/knowledge/scrape` — Ingest Markdown or polite SSRF-guarded URLs.
- `GET /api/usage/budget` — Monthly spend, threshold status (`50% / 75% / 90% / 100%`), local savings, and African currency conversions.
