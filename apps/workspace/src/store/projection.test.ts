import { describe, expect, it } from "vitest";
import { EventSchema, type AgentDefinition, type PosEvent } from "@pos/schemas";
import sequences from "../../../../packages/schemas/fixtures/mock_sequences.json";
import { applyEvent, emptyProjection, loadAgents, type Projection } from "./projection";

const AGENTS: AgentDefinition[] = ["orchestrator", "research", "coder", "writer", "validator", "memory"].map(
  (id) => ({
    id,
    name: id[0].toUpperCase() + id.slice(1),
    description: "d",
    capabilities: ["c"],
    tools: [],
    memory: { scope: "task", kind: "none" },
    model_profile: { provider: "ollama", model: "m", temperature: 0, max_tokens: 1 },
    permissions: [],
  }),
);

const parse = (raw: unknown[]): PosEvent[] => raw.map((e) => EventSchema.parse(e));
const HAPPY = parse(sequences.happy);
const FAIL = parse(sequences.fail);

function run(events: PosEvent[], upto = events.length): Projection {
  return events.slice(0, upto).reduce(applyEvent, loadAgents(emptyProjection(), AGENTS));
}

const st = (p: Projection, id: string) => p.nodes[id]?.state;
const idx = (events: PosEvent[], pred: (e: PosEvent) => boolean) => events.findIndex(pred) + 1;

describe("projection", () => {
  it("loads 6 idle agent nodes from GET /agents payload", () => {
    const p = loadAgents(emptyProjection(), AGENTS);
    expect(Object.keys(p.nodes)).toHaveLength(6);
    expect(Object.values(p.nodes).every((n) => n.state === "idle" && n.kind === "agent")).toBe(true);
    expect(p.nodes["agent:orchestrator"].position).toEqual({ x: 0, y: 0 });
  });

  it("wire fixtures are zod-valid", () => {
    expect(HAPPY.length).toBeGreaterThan(10);
    expect(FAIL.at(-1)?.type).toBe("execution.failed");
  });

  it("animates states through the happy path", () => {
    const tid = HAPPY[0].task_id;
    let p = run(HAPPY, 1);
    expect(st(p, `task:${tid}`)).toBe("running");
    expect(p.edges[`delegates:task:${tid}->agent:orchestrator`].active).toBe(true);

    p = run(HAPPY, idx(HAPPY, (e) => e.type === "task.planned"));
    expect(st(p, "agent:research")).toBe("queued");
    expect(st(p, "agent:writer")).toBe("queued");

    p = run(HAPPY, idx(HAPPY, (e) => e.type === "tool.started"));
    expect(st(p, "agent:research")).toBe("running");
    expect(st(p, "tool:web_search")).toBe("running");
    expect(p.edges["calls:agent:research->tool:web_search"].active).toBe(true);

    p = run(HAPPY, idx(HAPPY, (e) => e.type === "approval.requested"));
    expect(st(p, "agent:writer")).toBe("waiting_approval");
    expect(st(p, "tool:web_search")).toBe("completed");

    p = run(HAPPY, idx(HAPPY, (e) => e.type === "approval.granted"));
    expect(st(p, "agent:writer")).toBe("running");

    p = run(HAPPY);
    expect(st(p, `task:${tid}`)).toBe("completed");
    for (const a of ["orchestrator", "research", "writer", "validator"]) expect(st(p, `agent:${a}`)).toBe("completed");
    expect(st(p, "agent:coder")).toBe("idle");
    expect(Object.values(p.edges).some((e) => e.active)).toBe(false);
    expect(p.artifacts).toHaveLength(1);
    expect(Object.values(p.nodes).filter((n) => n.kind === "artifact")).toHaveLength(1);
    expect(p.log).toHaveLength(HAPPY.length);
  });

  it("failure path marks tool, agent, task as error", () => {
    const p = run(FAIL);
    expect(st(p, "tool:web_search")).toBe("error");
    expect(st(p, "agent:research")).toBe("error");
    expect(st(p, `task:${FAIL[0].task_id}`)).toBe("error");
    expect(st(p, "agent:orchestrator")).toBe("error"); // was running when execution failed
  });

  it("ignores duplicate / stale seq", () => {
    const p = run(HAPPY, 5);
    expect(applyEvent(p, HAPPY[4])).toBe(p);
    expect(applyEvent(p, HAPPY[2])).toBe(p);
  });

  it("new task resets agents and drops previous transient nodes", () => {
    const done = run(HAPPY);
    const next = applyEvent(done, { ...HAPPY[0], id: "n", task_id: "t2" });
    expect(st(next, "agent:research")).toBe("idle");
    expect(Object.values(next.nodes).filter((n) => n.kind === "tool")).toHaveLength(0);
    expect(Object.values(next.nodes).filter((n) => n.kind === "task")).toHaveLength(1);
    expect(next.artifacts).toHaveLength(1); // artifacts history survives
  });

  it("new task leaves foreign (non-projected) nodes and edges alone", () => {
    const p = run(HAPPY, 3);
    const foreign = { ...p.nodes["agent:coder"], id: "stress:1", kind: "tool" as const, ref_id: "stress:1" };
    const withForeign: Projection = {
      ...p,
      nodes: { ...p.nodes, "stress:1": foreign },
      edges: { ...p.edges, "x": { id: "x", source: "agent:coder", target: "stress:1", kind: "calls", active: true } },
    };
    const next = applyEvent(withForeign, { ...HAPPY[0], id: "n", task_id: "t2" });
    expect(next.nodes["stress:1"]).toEqual(foreign);
    expect(next.edges["x"]).toBeDefined();
  });

  it("unknown agent in an event gets a node lazily", () => {
    const p = applyEvent(run(HAPPY, 1), {
      ...HAPPY[1],
      seq: 1,
      type: "agent.started",
      payload: { agent_id: "ghost", parent_id: "orchestrator" },
    } as PosEvent);
    expect(st(p, "agent:ghost")).toBe("running");
  });

  it("does not mutate input projection", () => {
    const p = run(HAPPY, 3);
    const snapshot = JSON.stringify(p);
    applyEvent(p, HAPPY[3]);
    expect(JSON.stringify(p)).toBe(snapshot);
  });
});
