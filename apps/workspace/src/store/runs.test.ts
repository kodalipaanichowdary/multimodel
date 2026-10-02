import { describe, expect, it } from "vitest";
import { EventSchema, type AgentDefinition, type PosEvent } from "@pos/schemas";
import sequences from "../../../../packages/schemas/fixtures/mock_sequences.json";
import {
  applyEvent,
  emptyProjection,
  loadAgents,
  recordInvalid,
  runTimeline,
  scorecard,
  type Projection,
  type Scorecard,
} from "./projection";

const HAPPY: PosEvent[] = sequences.happy.map((e) => EventSchema.parse(e));
const FAIL: PosEvent[] = sequences.fail.map((e) => EventSchema.parse(e));

const agent = (id: string, name = id[0].toUpperCase() + id.slice(1)): AgentDefinition => ({
  id,
  name,
  description: "d",
  capabilities: ["c"],
  tools: [],
  memory: { scope: "task", kind: "none" },
  model_profile: { provider: "ollama", model: "m", temperature: 0, max_tokens: 1 },
  permissions: [],
});
const AGENTS = ["orchestrator", "research", "coder", "writer", "validator", "memory"].map((id) => agent(id));
const base = () => loadAgents(emptyProjection(), AGENTS);
const fold = (events: PosEvent[], p: Projection = base()) => events.reduce(applyEvent, p);

describe("scorecard (exact, against mock_sequences.json)", () => {
  it("happy", () => {
    expect(scorecard({ events: HAPPY, invalidDropped: 0 })).toEqual<Scorecard>({
      agents_used: 4,
      tools_called: 2,
      tools_failed: 0,
      approvals: 1,
      events_total: 22,
      events_invalid_dropped: 0,
      duration_ms: 5250,
      status: "completed",
    });
  });

  it("fail", () => {
    expect(scorecard({ events: FAIL, invalidDropped: 0 })).toEqual<Scorecard>({
      agents_used: 2,
      tools_called: 1,
      tools_failed: 1,
      approvals: 0,
      events_total: 9,
      events_invalid_dropped: 0,
      duration_ms: 2000,
      status: "failed",
    });
  });

  it("counts equal raw event-type counts", () => {
    for (const events of [HAPPY, FAIL]) {
      const sc = scorecard({ events, invalidDropped: 0 });
      const n = (t: string) => events.filter((e) => e.type === t).length;
      expect(sc.tools_called).toBe(n("tool.started"));
      expect(sc.tools_failed).toBe(n("tool.failed"));
      expect(sc.approvals).toBe(n("approval.requested"));
      expect(sc.events_total).toBe(events.length);
    }
  });

  it("is what the projection's run holds after folding", () => {
    const p = fold(HAPPY);
    expect(scorecard(p.runs[HAPPY[0].task_id])).toEqual(scorecard({ events: HAPPY, invalidDropped: 0 }));
    expect(p.runOrder).toEqual([HAPPY[0].task_id]);
  });

  it("partial run is 'running' with span duration", () => {
    const sc = scorecard({ events: HAPPY.slice(0, 5), invalidDropped: 0 });
    expect(sc).toMatchObject({ status: "running", events_total: 5, duration_ms: 1000, agents_used: 2 });
  });
});

describe("invalid frames", () => {
  it("count against the active running run only", () => {
    let p = fold(HAPPY.slice(0, 3));
    p = recordInvalid(recordInvalid(p));
    expect(p.runs[HAPPY[0].task_id].invalidDropped).toBe(2);
    p = fold(HAPPY.slice(3), p);
    expect(scorecard(p.runs[HAPPY[0].task_id]).events_invalid_dropped).toBe(2);
    expect(recordInvalid(p)).toBe(p); // finished run: not attributed
    expect(recordInvalid(base())).toEqual(base()); // no run at all
  });
});

describe("runTimeline", () => {
  it("happy: rows per agent with start/duration and tool chips", () => {
    const tl = runTimeline({ events: HAPPY });
    expect(tl.rows.map((r) => r.agent_id)).toEqual(["orchestrator", "research", "writer", "validator"]);
    const by = Object.fromEntries(tl.rows.map((r) => [r.agent_id, r]));
    expect(by.orchestrator).toMatchObject({ state: "completed", started_ms: 250, duration_ms: 4750, tools: [] });
    expect(by.research).toMatchObject({ state: "completed", started_ms: 1000, duration_ms: 1000 });
    expect(by.research.tools).toEqual([
      { call_id: "call1-11111111", tool_id: "web_search", status: "completed", duration_ms: 420 },
    ]);
    expect(by.writer).toMatchObject({ state: "completed", started_ms: 2250, duration_ms: 1500 });
    expect(by.writer.tools.map((c) => [c.tool_id, c.status])).toEqual([["fs_write", "completed"]]);
    expect(by.validator).toMatchObject({ started_ms: 4000, duration_ms: 500 });
    expect(tl.last_ts! - tl.start_ts!).toBe(5250);
  });

  it("live: shows planned rows queued and running chip mid-run", () => {
    const tl = runTimeline({ events: HAPPY.slice(0, 7) }); // up to tool.started
    const by = Object.fromEntries(tl.rows.map((r) => [r.agent_id, r]));
    expect(by.research.state).toBe("running");
    expect(by.research.tools[0].status).toBe("running");
    expect(by.writer).toMatchObject({ state: "queued", started_ms: null });
  });

  it("approval: waiting then running", () => {
    const at = (n: number) => runTimeline({ events: HAPPY.slice(0, n) }).rows.find((r) => r.agent_id === "writer")!;
    expect(at(12).state).toBe("waiting_approval");
    expect(at(13).state).toBe("running");
  });

  it("fail: failed chip, errored agents, untouched agents stay queued", () => {
    const by = Object.fromEntries(runTimeline({ events: FAIL }).rows.map((r) => [r.agent_id, r]));
    expect(by.research.state).toBe("error");
    expect(by.research.tools[0]).toMatchObject({ tool_id: "web_search", status: "failed", duration_ms: null });
    expect(by.orchestrator.state).toBe("error");
    expect(by.writer.state).toBe("queued");
  });
});

describe("chat projection", () => {
  it("happy: user prompt, live status lines settle to done, result + scorecard", () => {
    const p = fold(HAPPY);
    expect(p.chat.map((c) => c.kind)).toEqual([
      "user", "status", "status", "status", "status", "status", "status", "status", "status", "result", "scorecard",
    ]);
    const statuses = p.chat.filter((c) => c.kind === "status");
    expect(statuses.every((c) => c.kind === "status" && c.tone === "done" || (c.kind === "status" && c.tone === "info"))).toBe(true);
    const texts = statuses.map((c) => (c.kind === "status" ? c.text : ""));
    expect(texts).toContain("Research done (1.0s)");
    expect(texts).toContain("web_search done (420 ms)");
    expect(texts).toContain("Approved by mock-auto");
    expect(texts[1]).toBe("Plan: Research → Writer → Validator");
    const result = p.chat.find((c) => c.kind === "result");
    expect(result?.kind === "result" && result.artifact.content).toContain("# Report (mock)");
  });

  it("status lines update in place while live", () => {
    const mid = fold(HAPPY.slice(0, 7));
    expect(mid.chat.find((c) => c.id.endsWith(":tool:call1-11111111"))).toMatchObject({
      text: "web_search running",
      tone: "running",
    });
    const after = applyEvent(mid, HAPPY[7]);
    expect(after.chat).toHaveLength(mid.chat.length);
    expect(after.chat.find((c) => c.id.endsWith(":tool:call1-11111111"))).toMatchObject({ tone: "done" });
  });

  it("fail: red error names failing agent + tool; no running lines left", () => {
    const p = fold(FAIL);
    const err = p.chat.find((c) => c.kind === "error");
    expect(err).toMatchObject({ agent_id: "research", tool_id: "web_search" });
    expect(err?.kind === "error" && err.error).toContain("mock: upstream timeout");
    expect(p.chat.some((c) => c.kind === "status" && c.tone === "running")).toBe(false);
    expect(p.chat.at(-1)?.kind).toBe("scorecard");
  });

  it("history persists across tasks", () => {
    const second = HAPPY.map((e) => ({ ...e, id: `2-${e.id}`, task_id: "t2" }) as PosEvent);
    const p = fold(second, fold(FAIL, fold(HAPPY)));
    expect(p.chat.filter((c) => c.kind === "user")).toHaveLength(3);
    expect(p.chat.filter((c) => c.kind === "scorecard")).toHaveLength(3);
    expect(p.runOrder).toEqual([HAPPY[0].task_id, FAIL[0].task_id, "t2"]);
  });
});

describe("loadAgents after initial load", () => {
  it("places new agents on the outer ring and keeps existing positions", () => {
    const p = base();
    const next = loadAgents(p, [...AGENTS, agent("critic")]);
    expect(next.nodes["agent:research"].position).toEqual(p.nodes["agent:research"].position);
    const { x, y } = next.nodes["agent:critic"].position;
    expect(Math.hypot(x / 400, y / 300)).toBeCloseTo(1, 5);
  });
});
