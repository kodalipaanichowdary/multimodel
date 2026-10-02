# Personal AI OS

Spatial multi-agent workspace. Current phase: **P1 Living Shell** (see `GATES.md`).

```
apps/workspace   React + React Flow UI (projection of backend events)
apps/api         FastAPI: /agents, /tasks, /ws, /health; P1 mock executor
packages/schemas Pydantic (python/) + zod (ts/) contracts, shared fixtures
agents/<id>      manifest.yaml per agent
infrastructure/  nginx conf, compose smoke script
docs/decisions   ADRs
```

## Run (compose)

```
docker compose up -d --build --wait     # UI http://localhost:8080, API http://localhost:8000
bash infrastructure/smoke.sh            # end-to-end smoke through nginx
```

## Run (local dev)

```
python -m venv apps/api/.venv
apps/api/.venv/Scripts/pip install -e packages/schemas/python -e "apps/api[dev]"   # bin/ on *nix
npm install
cd apps/api && .venv/Scripts/python -m uvicorn app.main:app --port 8000    # terminal 1
npm run dev                                                                 # terminal 2 -> :5173
```

## Checks

```
cd apps/api && .venv/Scripts/python -m pytest -q && .venv/Scripts/ruff check . ../../packages/schemas/python
npm run typecheck && npm run lint && npm test
npm run e2e                 # Playwright on installed Edge (PW_CHANNEL=chrome to switch); HEADED=1 for vsync fps
```

Perf harness: open `/?stress=50` to pad the canvas to 50 nodes (FPS meter top-left).
Regenerate UI fixtures after changing the mock script: `cd apps/api && .venv/Scripts/python scripts/gen_fixtures.py`.

## Manual test checklist (P1)

1. Open the UI. 6 drifting dots; drag one, scroll to zoom, drag empty space to pan.
2. Hover a dot: name + state tag follows the cursor. Click: popup with capabilities/tools/permissions
   (dangerous ones marked ⚠); the dock switches to **Inspect**. Esc closes.
3. **Chat** (right dock >=1280px, slide-over drawer 768-1279px, bottom sheet <768px): type
   "Summarise MCP", Run. Live status lines appear ("Research started", "web_search running") and settle to done.
4. The result renders as markdown (heading, plan list, findings, quote) with an artifact card;
   "Open in inspector" jumps to Inspect > Artifacts. A scorecard follows (4 agents, 2 tools, 1 approval, 22 events).
5. **Run** tab: one row per agent with state, start offset, duration and tool chips; counters tick while live.
6. Run "please fail": red error naming Research + web_search; scorecard shows 1 tool fail, 9 events.
7. Run a third task: all earlier prompts, results and scorecards are still in the chat (session history).
8. **+ Agent**: submit with id "Bad Id" -> inline errors, nothing created. Fill a valid agent with fs.write
   (⚠ warning) -> node appears; same id again -> "already exists" inline.
9. Click the new agent -> "+ Include in next task" -> chip in composer -> Run: plan includes it, its timeline row completes.
10. Resize: dock edge drags and collapses; at 820px the drawer closes to a Chat button; at 390px drag the sheet handle.
    No horizontal scrolling at any width.
11. `/?stress=50`: meter shows 50 nodes and >=50 fps while panning.
