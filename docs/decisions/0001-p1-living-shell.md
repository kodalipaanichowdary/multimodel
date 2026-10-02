# ADR 0001 — P1 Living Shell foundations

Status: accepted (P1)

## Decisions

1. **Schemas: Pydantic is source of truth, zod mirrors 1:1.** Parity is enforced by shared
   fixtures in `packages/schemas/fixtures/` that both test suites must accept/reject identically.
   `mock_sequences.json` is generated from the backend script and checked for drift by pytest.
2. **UI graph is a pure fold over events** (`apps/workspace/src/store/projection.ts`).
   Every WS frame is zod-validated before projection; invalid frames are dropped and counted.
   The backend re-validates every event on `EventBus.publish`.
3. **Node ids are namespaced** (`agent:`, `tool:`, `task:`, `artifact:`). A new task resets only
   projection-owned nodes; foreign nodes (e.g. perf harness) are untouched.
4. **Drift is CSS-only** (compositor transform on an inner element), so React Flow positions,
   dragging and edges are unaffected and 50+ nodes cost no React renders.
5. **Registry is in-process**, seeded from `agents/<id>/manifest.yaml`. POST/PATCH mutate memory
   only. Persistence belongs to the Memory layer (P3) — not built in P1.
6. **Mock executor is P1-only** (`apps/api/app/mock_executor.py`). It emits the real event
   contract; P2 replaces it with the runtime. Approval is auto-granted (`by: mock-auto`) in P1.
7. Postgres/Redis are provisioned and health-checked in P1 but not yet used for data.
