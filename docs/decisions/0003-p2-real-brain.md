# ADR 0003 — P2 Real Brain: runtime, grounding, approvals, persistence

Status: accepted (P2)

## Runtime
- **Default executor is real** (`app/agent_runtime/executor.py`). The scripted P1 executor runs only with
  `MOCK_EXECUTOR=1` (contract tests). `/health` reports which one is live.
- **Pipeline** `plan -> research -> write -> validate (-> one revision) -> finalize`, sequential (parallel = P3),
  built on LangGraph behind `Workflow`/`Execution` (`workflow.py`). Nothing else imports LangGraph.
- **Model gateway** `LLMClient.generate(profile, messages, schema)`: Ollama `/api/chat`, streamed so TTFT is
  measured, T=0, `format` = Pydantic JSON Schema (grammar-constrained). `StubClient` exists for tests only.
- **Self-heal** in one place (`heal.py`): validate -> on `ValidationError` append the exact `e.errors()` and retry
  once -> else a typed fallback. Every attempt emits `model.metrics`.
- **Context validators** (pydantic validation context) reject run-specific lies: planner agent ids outside the
  pipeline, research sources that were not fetched, citation numbers outside 1..n.

## Grounding
- The Writer cites by **source number** (`[n]` in text, `citations: [n]`). Code maps n -> URL. Small models
  copied numbers into URL fields; asking them for URLs only added a hallucination surface.
- The Validator is **rule-based** (`grounding.py`, no model): every sentence needs a valid `[n]`, and its key
  terms (names, numbers, dates) must appear in the passage of the page it cites.
- **Citation alignment**: an uncited / mis-cited sentence whose key terms are *all* in one fetched passage gets its
  marker re-pointed there (event: "Re-attached citation"). A sentence no single fetched page supports is never rescued.
- One revision with the validator's issues; then "Could not verify" with the sources checked. No sources at all ->
  "Could not verify: web search returned no usable sources".

## Tools (MCP)
- `mcp/web_search` (DuckDuckGo HTML, topped up from the Wikipedia API; keyless), `mcp/fetch_url`
  (public addresses only, every redirect hop checked; 2 MB / 15 s caps), `mcp/fs_write` (sandboxed).
- The API calls them over in-process MCP client sessions (same JSON-RPC protocol as stdio, no subprocesses).
- `ToolRegistry` checks the agent manifest (`tools` + `permissions`) before any call; denial is a `tool.failed`.
- `fs.write` / `terminal.exec` tools need interactive approval: `approval.requested` blocks the run on a future;
  `POST /approvals/{id}` resolves it; timeout = deny. Deny skips the tool (no `tool.started`) and the run continues.

## Events (contract additions, Pydantic + zod + fixtures updated together)
- `approval.denied {approval_id, by, reason}` — needed so Deny / timeout is unambiguous in UI and log.
- `model.metrics {agent_id, model, attempt, ttft_ms, tok_s, total_ms, prompt_tokens, completion_tokens}`.

## Persistence
- `EventRepository` interface; `SqliteEventRepository` (`apps/api/data/pos.db`, gitignored). The bus appends
  before fan-out. `GET /tasks`, `GET /tasks/{id}/events`. Runs left open by a restart are closed with
  `execution.failed: interrupted`. `POS_DB_PATH=none` disables persistence (P1 contract tests only).
- The UI buffers live frames, applies the persisted log, then flushes (no gaps, no duplicates).

## Constraints recorded
- Writer runs on `llama3.2:3b`, not `mistral:7b`: with mistral loaded only ~2.8 GB RAM was free and Ollama hit
  out-of-memory. mistral stays in the benchmark matrix.
- The real executor rejects `selected` extra agents (422): the P2 pipeline is fixed.
