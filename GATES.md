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
- [ ] docker compose up
- [x] tests+lint green

G1 status 2026-10-02: 8/9 PASS. `docker compose up` BLOCKED � no Docker daemon reachable without elevation; run `bash infrastructure/smoke.sh`.

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
