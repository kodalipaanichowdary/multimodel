import { describe, expect, it } from "vitest";
import { EventSchema, type PosEvent } from "@pos/schemas";
import { applyEvent, emptyProjection, liveStats, runTimeline, type Projection } from "./projection";

// Hand-built real-runtime events (zod-validated): approval + model.metrics paths.
const T = "33333333-3333-3333-3333-333333333333";
const BASE = Date.parse("2026-10-02T10:00:00Z");
let seq = 0;
const ev = (type: string, payload: Record<string, unknown>): PosEvent =>
  EventSchema.parse({ id: `p2-${seq}`, type, task_id: T, seq: seq, ts: new Date(BASE + seq++ * 250).toISOString(), payload });

function build(final: "granted" | "denied" | "killed") {
  seq = 0;
  const evs = [
    ev("task.created", { prompt: "who chairs it? save it to a file" }),
    ev("agent.started", { agent_id: "orchestrator", parent_id: null }),
    ev("model.metrics", { agent_id: "orchestrator", model: "llama3.2:3b", attempt: 1, ttft_ms: 412, tok_s: 24.4, total_ms: 5100, prompt_tokens: 110, completion_tokens: 130 }),
    ev("task.planned", { steps: [{ agent_id: "research", goal: "g" }, { agent_id: "writer", goal: "g" }, { agent_id: "validator", goal: "g" }] }),
    ev("agent.started", { agent_id: "writer", parent_id: "orchestrator" }),
    ev("model.metrics", { agent_id: "writer", model: "llama3.2:3b", attempt: 1, ttft_ms: 230, tok_s: 26.1, total_ms: 1400, prompt_tokens: 980, completion_tokens: 28 }),
    ev("approval.requested", { approval_id: "appr-1", agent_id: "writer", tool_id: "fs_write", reason: "save the answer" }),
  ];
  if (final === "killed") {
    evs.push(ev("execution.failed", { error: "killed by user", agent_id: "writer" }));
  } else {
    evs.push(ev(final === "granted" ? "approval.granted" : "approval.denied", { approval_id: "appr-1", by: "user", ...(final === "denied" ? { reason: "denied by user" } : {}) }));
  }
  return evs;
}
const fold = (evs: PosEvent[]) => evs.reduce(applyEvent, emptyProjection() as Projection);
const card = (p: Projection) => p.chat.find((c) => c.kind === "approval");

describe("approval card (G2.5) — projected from events only", () => {
  it("pending while requested; agent waits", () => {
    const evs = build("granted");
    const p = fold(evs.slice(0, -1));
    expect(card(p)).toMatchObject({ status: "pending", approval_id: "appr-1", agent_id: "writer", tool_id: "fs_write", reason: "save the answer" });
    expect(p.nodes["agent:writer"].state).toBe("waiting_approval");
    expect(runTimeline(p.runs[T]).rows.find((r) => r.agent_id === "writer")?.state).toBe("waiting_approval");
  });
  it("granted -> card granted, agent running", () => {
    const p = fold(build("granted"));
    expect(card(p)).toMatchObject({ status: "granted", by: "user" });
    expect(p.nodes["agent:writer"].state).toBe("running");
  });
  it("denied -> card denied, agent continues (step aborted, run not failed)", () => {
    const p = fold(build("denied"));
    expect(card(p)).toMatchObject({ status: "denied", by: "user" });
    expect(p.nodes["agent:writer"].state).toBe("running");
    expect(runTimeline(p.runs[T]).rows.find((r) => r.agent_id === "writer")?.state).toBe("running");
  });
  it("run killed while waiting -> card cancelled, agent + task error", () => {
    const p = fold(build("killed"));
    expect(card(p)).toMatchObject({ status: "cancelled" });
    expect(p.nodes["agent:writer"].state).toBe("error");
    expect(p.chat.find((c) => c.kind === "error")).toMatchObject({ agent_id: "writer", error: "killed by user" });
  });
});

describe("model metrics in the live strip (G2.8)", () => {
  it("liveStats exposes the latest model call and the call count", () => {
    const p = fold(build("granted"));
    const s = liveStats(p.runs[T], 0, 0);
    expect(s.model).toEqual({ agent_id: "writer", name: "llama3.2:3b", ttft_ms: 230, tok_s: 26.1 });
    expect(s.model_calls).toBe(2);
  });
  it("is null before any model call", () => {
    const p = fold(build("granted").slice(0, 2));
    expect(liveStats(p.runs[T], 0, 0)).toMatchObject({ model: null, model_calls: 0 });
  });
  it("node detail shows model + TTFT + tok/s", () => {
    const p = fold(build("granted").slice(0, 3));
    expect(p.detail["agent:orchestrator"]).toBe("llama3.2:3b · TTFT 412 ms · 24.4 tok/s");
  });
});
