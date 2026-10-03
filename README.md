# Personal AI OS

Spatial multi-agent workspace. Current phase: **P2 Real Brain** (see `GATES.md`, ADRs in `docs/decisions`).

```
apps/workspace   React + React Flow UI (projection of backend events)
apps/api         FastAPI: /agents, /tasks, /tasks/{id}/events|kill, /approvals/{id}, /ws, /health; real runtime
mcp/<tool>       MCP tool servers: web_search, fetch_url, fs_write
benchmarks/      run_p2.py (schema/latency matrix), soak_p2.py (20 live runs)
packages/schemas Pydantic (python/) + zod (ts/) contracts, shared fixtures
agents/<id>      manifest.yaml per agent
scripts/         setup / dev / check / preview (Node, no extra deps)
docs/decisions   ADRs
```

## Prerequisites for real answers

Ollama running on `127.0.0.1:11434` with the models in `agents/*/manifest.yaml`:

```
ollama pull llama3.2:3b
ollama pull phi3.5
ollama pull mistral:7b      # benchmark only; needs ~5 GB free RAM
```

Without Ollama the API still starts; a task then ends with `model unavailable` (a handled failure).

## Quick start

Needs Python >= 3.10 and Node >= 18 on PATH. Nothing else: no admin rights, no global installs, no containers.

```
npm run setup    # apps/api/.venv + editable Python installs + npm workspaces
npm run dev      # API http://127.0.0.1:8000 + UI http://localhost:5173 — Ctrl+C stops both
npm run check    # ruff, ruff format, pytest, tsc, eslint (0 warnings), vitest, playwright; stops at first failure
npm run build    # production UI -> apps/workspace/dist
npm run preview  # build, then serve dist with vite preview (:4173) + API (:8000)
```

All settings live in `.env.example` (ports, executor, model provider, search provider, approval timeout,
event log path); copy it to `.env` to override. `dev`/`preview` refuse to start if a port is taken.

**Windows (PowerShell):** run the commands exactly as above. They are plain `node` scripts, so no
execution-policy change and no admin prompt is needed. The venv lives at `appspi\.venv\Scripts\python.exe`.

**Playwright:** uses the installed Microsoft Edge by default (`PW_CHANNEL=chrome` for Chrome); no browser
download. The suite starts its own API + UI on 8001/5174, so it can run while `npm run dev` is up.
`HEADED=1 npm run e2e` measures FPS with real vsync. The suite starts two server pairs: P1 contract
(mock executor, 8001/5174) and the real runtime with a stub model + offline tool corpus (8002/5175).

Live checks (real Ollama + internet):

```
cd apps/api && RUN_LIVE=1 .venv/Scripts/python -m pytest tests/test_live.py -s   # golden question
apps/api/.venv/Scripts/python benchmarks/run_p2.py      # -> benchmarks/p2_baseline.{json,md}
apps/api/.venv/Scripts/python benchmarks/soak_p2.py     # -> benchmarks/p2_soak.json
```

Perf harness: open `/?stress=50` to pad the canvas to 50 nodes (FPS meter top-left).
Regenerate UI fixtures after changing the mock script: `cd apps/api && .venv/Scripts/python scripts/gen_fixtures.py`.

## Manual test checklist (P1)

1. Open the UI. 6 drifting dots; drag one, scroll to zoom, drag empty space to pan.
2. Hover a dot: name + state tag follows the cursor. Click: popup with capabilities/tools/permissions
   (dangerous ones marked ⚠); the dock switches to **Inspect**. Esc closes.
3. **Chat** (right dock >=1280px, slide-over drawer 768-1279px, bottom sheet <768px): type
   "Summarise MCP", Run. Live status lines appear ("Research started", "web_search running") and settle to done.
4. While it runs, a **live strip** closes the run in chat: planned agents as dots on a line, a pulse that
   travels to the active agent (amber + "awaiting approval" for Writer), tools running/ok/failed, ev/s, elapsed.
   The result renders as markdown with an artifact card; "Open in inspector" jumps to Inspect > Artifacts.
   On finish the strip becomes a chip "✓ 4 agents · 2 tools · X.Xs ▸" in place (nothing above it moves);
   click it for the full scorecard (4 agents, 2 tools, 1 approval, 22 events).
5. **Run** tab: one row per agent with state, start offset, duration and tool chips; counters tick while live.
6. Run "please fail": red error naming Research + web_search; chip "✗ 2 agents · 1 tool"; scorecard shows 1 tool fail, 9 events.
7. Run a third task: all earlier prompts, results and scorecards are still in the chat (session history).
8. **+ Agent**: submit with id "Bad Id" -> inline errors, nothing created. Fill a valid agent with fs.write
   (⚠ warning) -> node appears; same id again -> "already exists" inline.
9. Click the new agent -> "+ Include in next task" -> chip in composer -> Run: plan includes it, its timeline row completes.
10. Resize: dock edge drags and collapses; at 820px the drawer closes to a Chat button; at 390px drag the sheet handle.
    No horizontal scrolling at any width.
11. `/?stress=50`: meter shows 50 nodes and >=50 fps while panning.
12. After a run, no two dots/labels overlap (Report and fs_write sit apart near Writer).
13. OS "reduce motion" on: no drift, no pulses, no pulse travel; states still shown by colour and text.

## Manual test checklist (P2 — real answers)

Needs Ollama running (start it from its tray app so it uses the GPU) and internet.

1. `npm run dev`, open http://localhost:5173. `GET /api/health` says `"executor": "real"`.
2. Ask **who is cm of telangana**. Watch: Orchestrator plans, Research runs `web_search` then `fetch_url`
   (yellow tool dots), Writer drafts, Validator checks. The strip shows **TTFT · tok/s** from the model.
3. The answer cites `[1]` and lists the fetched page (Wikipedia) under **Sources**. Open Inspect → Events to see
   the `model.metrics`, `tool.*` and the validator's notes ("Re-attached citation" / "Rejected: …").
4. Ask something no page will answer well, e.g. a made-up name: the run ends with **Could not verify** and the
   sources it checked, never with an invented answer.
5. Ask a question and add **"save it to a file"**: an amber **Approval needed** card appears; the Writer waits.
   **Allow once** writes `apps/api/data/artifacts/<id>-answer.md`; **Deny** skips the write and still answers.
6. While a run is going, press **Stop** on the strip (or click the busy agent's dot → Stop): the agent turns red,
   chat shows "killed by user", the chip shows ✗.
7. Reload the page: earlier questions, answers and chips come back (SQLite event log).
8. Stop Ollama and ask again: the run ends with a red "model unavailable" error, nothing crashes.

