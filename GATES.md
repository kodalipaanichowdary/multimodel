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
- [ ] G1.8 one-command local run + production UI build (replaces docker compose; Docker not available)
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
- [ ] G1.25 no Docker/compose/nginx files or references remain (git grep clean)
- [ ] G1.26 npm run setup works from a fresh clone (venv + deps)
- [ ] G1.27 npm run dev starts API :8000 + UI :5173 with one command, Ctrl+C stops both, no orphan processes
- [ ] G1.28 npm run check runs every lint/test suite and exits non-zero on any failure
- [ ] G1.29 npm run build produces apps/workspace/dist; vite preview serves it and talks to API
- [ ] G1.30 /health no longer mentions postgres/redis; returns {status, version, executor}


## G2 — Real Brain

- [ ] real Orchestrator->Research->MCP tool->result
- [ ] typed outputs+retry+fallback
- [ ] Ollama T=0 schema acc >=95% on 30 prompts with TTFT/t/s/latency logged
- [ ] UI states from real events
- [ ] kill agent->ERROR
- [ ] approval for terminal/fs write
- [ ] 20 runs zero unhandled exceptions

## G3 — Swarm+Trust

- [ ] 3 concurrent branches wall<=0.6x sequential
- [ ] validator catches >=9/10 seeded faults
- [ ] memory persists across sessions, no cross-project leak
- [ ] audit log+OTel
- [ ] offline run passes
- [ ] router local/cloud by privacy flag
- [ ] 3-model benchmark matrix + recommendation
- [ ] 50-task soak >=95%
