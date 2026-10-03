# GATES

Phases: P1 Living Shell -> gate G1 -> P2 Real Brain -> gate G2 -> P3 Swarm+Trust -> gate G3.
A gate passes only with pasted command output / test results as evidence.

## G1 — Living Shell

- [x] 6 nodes float/drag/zoom/pan
- [x] hover tag
- [x] click popup
- [x] nodes from GET /agents
- [x] WS mock task animates states
- [x] event schema validated (Pydantic+zod)
- [x] >=50fps @50 nodes
- [x] G1.8 one-command local run + production UI build (replaces docker compose; Docker not available)
- [x] tests+lint green
- [x] G1.10 final result + artifact shown in chat after run
- [x] G1.11 scorecard counts == event counts (happy + fail fixtures)
- [x] G1.12 live timeline per agent with tool chips
- [x] G1.13 add agent via UI: node appears, in GET /agents, invalid manifest -> error
- [x] G1.14 no horizontal scroll; chat usable at 1440, 820, 390 px
- [x] G1.15 chat history persists across tasks in session
- [x] G1.16 all earlier G1 tests still pass
- [x] G1.17 live strip in chat while running: agent dots on a line, travelling pulse to active agent, live tools running/done, ev/s, elapsed
- [x] G1.18 on finish strip collapses to 1-line summary chip; full scorecard only on click
- [x] G1.19 strip + chip derived only from Run.events (pure fns, unit-tested on fixtures)
- [x] G1.20 no layout shift of chat when strip collapses; works at 1440/820/390
- [x] G1.21 reduced-motion: no pulse animation, static state
- [x] G1.22 elapsed uses event timestamps (no browser-clock mix) once run is done; live uses clock offset captured from first event
- [x] G1.23 node overlap near Writer fixed (no two nodes overlap at default layout)
- [x] G1.24 all earlier G1 tests pass
- [x] G1.25 no Docker/compose/nginx files or references remain (git grep clean)
- [x] G1.26 npm run setup works from a fresh clone (venv + deps)
- [x] G1.27 npm run dev starts API :8000 + UI :5173 with one command, Ctrl+C stops both, no orphan processes
- [x] G1.28 npm run check runs every lint/test suite and exits non-zero on any failure
- [x] G1.29 npm run build produces apps/workspace/dist; vite preview serves it and talks to API
- [x] G1.30 /health no longer mentions postgres/redis; returns {status, version, executor}


## G2 — Real Brain

- [x] G2.1  real task: Orchestrator -> Research -> web_search + fetch_url (MCP) -> Writer -> Validator -> result; no mocks on default path
- [x] G2.2  every agent output is a Pydantic model; invalid -> 1 retry with exact ValidationError appended -> else fallback payload
- [x] G2.3  Ollama T=0, 30 prompts: schema accuracy >=95%; TTFT, tok/s, total latency logged to benchmarks/p2_baseline.json
- [x] G2.4  every UI state change comes from a real backend event; kill an agent mid-run -> node + chat show ERROR
- [x] G2.5  fs.write / terminal.exec require interactive approval (UI Allow once / Deny); Deny aborts step cleanly
- [x] G2.6  20 consecutive runs, zero unhandled exceptions
- [x] G2.7  grounding: answer cites >=1 fetched URL; if search returns nothing, agent says "could not verify" (test with stubbed empty search)
- [x] G2.8  live strip shows real TTFT + tok/s from model events
- [x] G2.9  mock executor only behind MOCK_EXECUTOR=1 (tests); default path is real
- [x] G2.10 event log persisted (SQLite behind a repository interface); reload restores chat/runs
- [x] G2.11 all G1 tests still pass; npm run check green

## G3 — Swarm+Trust

- [ ] 3 concurrent branches wall<=0.6x sequential
- [ ] validator catches >=9/10 seeded faults
- [ ] memory persists across sessions, no cross-project leak
- [ ] audit log+OTel
- [ ] offline run passes
- [ ] router local/cloud by privacy flag
- [ ] 3-model benchmark matrix + recommendation
- [ ] 50-task soak >=95%
