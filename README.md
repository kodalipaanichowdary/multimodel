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
