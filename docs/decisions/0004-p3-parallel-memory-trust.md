# ADR 0004 - P3: parallel branches, hardened validator, injection defence, memory, audit, routing

Status: accepted (P3)

## Preflight
- `npm run doctor` checks venv python, node, git identity, Ollama up, models pulled (manifests + nomic-embed-text),
  GPU share of a loaded model (`/api/ps size_vram`), free RAM, ports, internet. Every failure prints its fix;
  exit 1 on a hard failure. It never starts Ollama (a shell-started Ollama ran CPU-only on this machine).

## Parallel execution (G3.6)
- `PlanStep` gains optional `id`, `depends_on`, `query` (Pydantic + zod + fixtures together). `Plan` validates the
  DAG: unique ids, `depends_on` may only name earlier ids (no cycles by construction).
- LangGraph `Send` fan-out per dependency level, fan-in through an `operator.add` reducer, all behind our
  `Workflow.fan_out` / `Branch`; nothing outside `workflow.py` imports LangGraph.
- Branch instances are `research#k` (one branch keeps `research`), so existing event types carried it: no new event.
- **Honest limit**: one 4 GB GPU, so model calls share one `asyncio.Semaphore` (`MODEL_CONCURRENCY=1`).
  The speed-up comes from overlapping tool I/O. Branches therefore do NOT summarise with the model; they return
  evidence (fetched passages) and the single Writer call does the reasoning. Live: research stage 6.31 s -> 1.98 s
  (ratio 0.31), model calls in flight never above 1. `PARALLEL_BRANCHES=0` keeps the sequential baseline.

## Validator (G3.7) and injection defence (G3.8)
- `validate_draft` (rule-based, no model) catches: truncated output, empty / no-claim answers, URLs that were not
  fetched, repeated sentences (removed, noted), mis-cited sentences (re-pointed only when one page supports all
  key terms), unsupported claims (term co-occurrence within a 3-segment window), sources that disagree on a number.
  Seeded-fault table: 10/10 caught, controls pass.
- Fetched text is DATA: instruction-like lines are stripped before passage selection, pages left with < 40 content
  chars are dropped, prompts label SOURCES as untrusted, and only code (planner output -> pipeline) calls tools,
  so text inside a page can never trigger a tool. Tested with a hostile page and a deliberately gullible model.

## Memory (G3.9)
- `MemoryRepository` interface; `SqliteMemoryRepository` = FTS5 + optional `nomic-embed-text` vectors (cosine
  >= 0.55), FTS5-only fallback when embeddings fail or are off. Layers: personal (all projects), project (scope
  key = project id), execution (per task). `memory_search` / `memory_write` are tools on the same permission +
  audit path as MCP tools. Recall results become citable sources (`memory://...`).

## Audit + traces (G3.10)
- Both are **bus sinks** (event-sourced): agents cannot forget to audit, and the log covers exactly what the UI saw.
- Audit: SQLite table with `BEFORE UPDATE/DELETE` triggers that abort (append-only enforced by the DB) and a
  SHA-256 hash chain (`prev_hash`) so out-of-band edits are detected by `GET /audit/verify`. Records `tool.*`,
  `approval.*`, `model.metrics`. Read-only API, no write endpoint.
- OpenTelemetry SDK: one trace per task, spans rebuilt from event timestamps (task -> agent -> tool / model).
  Exported by a custom `LocalFileSpanExporter` to `apps/api/data/traces/<task_id>.jsonl`. No OTLP or other network
  exporter is installed or configured (tested). `POS_AUDIT_DB=none` / `POS_TRACES_DIR=none` disable them.
- A failing sink is logged and never breaks a run.

## Router + offline (G3.11)
- `ModelRouter` sits behind the unchanged `LLMClient` interface. Inputs: the task's privacy flag (context variable
  set per run, inherited by branches) and the call kind (orchestrator -> plan, research, writer -> write).
  Policy: private -> local; offline -> local; no cloud key -> local; otherwise `CLOUD_KINDS` decides per kind.
  Tasks are **private by default** (API and UI toggle).
- `CloudClient` (OpenAI-compatible) exists but is disabled without `CLOUD_API_KEY`; nothing in the repo needs a key.
- `POS_OFFLINE=1`: `net.read` tools fail fast with `tool.failed "offline: ..."` (no network attempt), the router
  never picks cloud, and runs end honestly ("Could not verify") or answer from memory.

## Benchmarks (G3.12, G3.13)
- `benchmarks/run_p3_matrix.py`: 36 prompts x 3 models over 4 roles with production prompts and schemas,
  deterministic golden rubric 1-5 (no LLM judge). `benchmarks/soak_p3.py`: 50 mixed real tasks, gate = >= 95%
  completed-or-honestly-unverified, 0 unhandled, RSS growth < 20%, audit chain intact, one trace per run.
- Both refuse to start below 6 GiB free RAM (ENV RULES) and never start Ollama. Results: see
  `benchmarks/p3_matrix.md` and `benchmarks/p3_soak.json`.
- Matrix (2026-10-03, 4 GB GPU, old planner prompt), mean score by role:

  | model | GPU share | median call | planner | research | writer | reasoning |
  |---|---|---|---|---|---|---|
  | llama3.2:3b | 0.80 | 0.9 s | 2.75 | 5 | 3.5 | 4.25 |
  | phi3.5 | 0.60 | 2.2 s | 3.75 | 5 | 4.4 | 4.62 |
  | mistral:7b | 0.46 | 6.4 s | 4.0 | 5 | 4.6 | 3.5 |

- Planner fix (prompt "each query max 8 words, no repeated phrases" + `clamp_query`): planner rows rerun with
  the new prompt: llama3.2:3b 2.75 -> 3.5, phi3.5 3.75 -> 2.5, mistral:7b 4.0 -> 4.5. Remaining llama misses:
  over-branching single-fact questions (3 branches for 1) and one plan without step ids (DAG validator rejects,
  runtime falls back to the default plan).
- **Models stay as they are (all agents on llama3.2:3b).** mistral:7b beats llama by >= 1.0 on planner (+1.0) and
  writer (+1.1), but: it runs only 46% on the GPU, a call takes ~7x longer, and loading it next to llama is the
  configuration that ran out of memory in P2 (ADR 0003). The second condition for a switch (parallel test +
  golden question still pass with it) was not run. phi3.5 is within 1.0 on every role it leads. Revisit on a
  GPU that holds a 7B model fully, or with one model for all roles.

## Out of scope (unchanged)
- 3D/R3F, Build Mode, desktop packaging, cloud keys, deployment, Docker.
