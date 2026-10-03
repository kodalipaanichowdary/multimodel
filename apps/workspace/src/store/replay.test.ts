/**
 * G2.10 flake investigation: history replay + buffered live frames must apply each event once.
 * Root cause of the flake was NOT here (a stale e2e pos.db reused via Windows PID reuse, see
 * e2e/run-dir.ts); these tests pin down that the store side is correct.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { EventSchema, type PosEvent } from "@pos/schemas";
import { useGraph } from "./graph";

const initial = useGraph.getState();
const BASE = Date.parse("2026-10-03T10:00:00Z");

function run(taskId: string, prompt: string): PosEvent[] {
  let seq = 0;
  const ev = (type: string, payload: Record<string, unknown>) =>
    EventSchema.parse({ id: `${taskId}-${seq}`, type, task_id: taskId, seq, ts: new Date(BASE + seq++ * 100).toISOString(), payload });
  return [
    ev("task.created", { prompt }),
    ev("agent.started", { agent_id: "orchestrator", parent_id: null }),
    ev("agent.started", { agent_id: "research", parent_id: "orchestrator" }),
    ev("agent.completed", { agent_id: "research", summary: "ok" }),
    ev("agent.completed", { agent_id: "orchestrator", summary: "done (grounded)" }),
    ev("execution.completed", { duration_ms: 400, artifact_ids: [] }),
  ];
}

const raw = (e: PosEvent) => JSON.stringify(e);
const users = () => useGraph.getState().chat.filter((c) => c.kind === "user");

beforeEach(() => useGraph.setState(initial, true));

describe("history replay vs live frames", () => {
  it("applies the persisted log, then the overlapping live buffer, once", () => {
    const evs = run("11111111-1111-1111-1111-111111111111", "Who chairs it? (persist check)");
    for (const e of evs.slice(0, 4)) useGraph.getState().ingest(raw(e), { history: true });
    for (const e of evs.slice(2)) useGraph.getState().ingest(raw(e)); // buffer overlaps events 2..3
    const s = useGraph.getState();
    expect(users()).toHaveLength(1);
    expect(s.runs["11111111-1111-1111-1111-111111111111"].events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("a full replay after reload of an already-seen run changes nothing", () => {
    const evs = run("22222222-2222-2222-2222-222222222222", "Q (persist check)");
    for (const e of evs) useGraph.getState().ingest(raw(e));
    const before = useGraph.getState();
    for (const e of evs) useGraph.getState().ingest(raw(e), { history: true });
    expect(useGraph.getState().chat).toBe(before.chat);
    expect(users()).toHaveLength(1);
  });

  it("two persisted tasks with the same prompt are two messages (faithful to the log)", () => {
    for (const id of ["33333333-3333-3333-3333-333333333333", "44444444-4444-4444-4444-444444444444"])
      for (const e of run(id, "Q (persist check)")) useGraph.getState().ingest(raw(e), { history: true });
    expect(users()).toHaveLength(2); // what the flaky e2e saw: a stale DB already held one such task
  });
});
