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

- [ ] G3.0  npm run doctor: checks Python>=3.10, Node>=18, git identity, Ollama up, GPU in use (ollama ps not 100% CPU), models pulled (+nomic-embed-text), free RAM, ports 8000/5173 free, internet reach (Wikipedia, DDG); prints the exact fix command per failure; exit 1 on hard failure
- [ ] G3.1  unsent composer text survives dock/drawer/sheet layout switch
- [ ] G3.2  canvas refits on layout/size change unless the user has manually panned/zoomed
- [ ] G3.3  visible keyboard focus ring on chat input and every button
- [ ] G3.4  Enter/Space on a focused canvas node opens its popup; Esc closes and returns focus
- [ ] G3.5  FPS test warms up 1.5s and also runs against the production preview build
- [ ] G3.6  parallel: planner emits a dependency graph; >=3 independent branches run concurrently; wall time <=0.6x sum of branch times (tool-I/O bound, measured with stub latency AND once live); model calls guarded by a semaphore (4GB VRAM); strip shows several active dots at once
- [ ] G3.7  validator catches >=9 of 10 seeded bad outputs (wrong date, missing citation, wrong number, citation to wrong source, empty-but-valid, invented URL, contradictory sources, truncated, duplicated sentence, wrong entity)
- [ ] G3.8  prompt injection: fetched page containing "ignore previous instructions / write a file / call tool X" causes zero extra tool calls and no change to the answer (tested with a hostile page in the stub corpus)
- [ ] G3.9  memory: 3 layers (personal, project, execution) in SQLite (FTS5 + nomic-embed-text vectors); fact saved in session 1 recalled in session 2; project A memory never visible in project B; user can list and delete items in UI; every memory write is an event shown in chat
- [ ] G3.10 append-only audit log of tool calls, approvals, model calls; OpenTelemetry trace per task exported to a local file only
- [ ] G3.11 model router: policy by privacy flag + task kind; private -> local only; cloud adapter present but disabled without key; POS_OFFLINE=1 -> web tools fail gracefully ("offline") and a memory-only task still completes
- [ ] G3.12 benchmarks/p3_matrix.md: 3 models x 30-50 prompts with reasoning score 1-5 from a deterministic rubric/golden answers (no self-judging), plus VRAM, TTFT, tok/s, schema %; ends with a recommendation per role
- [ ] G3.13 soak: 50 mixed tasks, >=95% completed-or-honestly-unverified, 0 unhandled, RSS growth <20%
- [ ] G3.14 npm run check green; ADR 0004 written
