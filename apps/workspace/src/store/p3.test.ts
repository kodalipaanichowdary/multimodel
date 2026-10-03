import { describe, expect, it } from "vitest";
import { EventSchema, type AgentDefinition, type PosEvent } from "@pos/schemas";
import { activeIndices, agentLabel, applyEvent, emptyProjection, loadAgents, stripModel, type Projection } from "./projection";

const T = "44444444-4444-4444-4444-444444444444";
const BASE = Date.parse("2026-10-03T10:00:00Z");
let seq = 0;
const ev = (type: string, payload: Record<string, unknown>): PosEvent =>
  EventSchema.parse({ id: `p3-${seq}`, type, task_id: T, seq, ts: new Date(BASE + seq++ * 100).toISOString(), payload });

const research: AgentDefinition = {
  id: "research",
  name: "Research",
  description: "d",
  capabilities: ["c"],
  tools: ["web_search"],
  memory: { scope: "task", kind: "none" },
  model_profile: { provider: "ollama", model: "m", temperature: 0, max_tokens: 1 },
  permissions: ["net.read"],
};

function parallelRun() {
  seq = 0;
  return [
    ev("task.created", { prompt: "Compare A, B and C" }),
    ev("agent.started", { agent_id: "orchestrator", parent_id: null }),
    ev("task.planned", {
      steps: [
        { id: "r1", agent_id: "research#1", goal: "A", query: "A facts" },
        { id: "r2", agent_id: "research#2", goal: "B", query: "B facts" },
        { id: "r3", agent_id: "research#3", goal: "C", query: "C facts" },
        { id: "w", agent_id: "writer", goal: "compare", depends_on: ["r1", "r2", "r3"] },
        { id: "v", agent_id: "validator", goal: "check", depends_on: ["w"] },
      ],
    }),
    ev("agent.started", { agent_id: "research#1", parent_id: "orchestrator" }),
    ev("agent.started", { agent_id: "research#2", parent_id: "orchestrator" }),
    ev("agent.started", { agent_id: "research#3", parent_id: "orchestrator" }),
    ev("agent.completed", { agent_id: "research#2", summary: "done" }),
  ];
}

describe("parallel research branches in the UI projection (G3.6)", () => {
  it("labels branch instances after their base agent", () => {
    expect(agentLabel("research#2", { research })).toBe("Research #2");
    expect(agentLabel("research", { research })).toBe("Research");
    expect(agentLabel("ghost#1", {})).toBe("ghost #1");
  });

  it("creates one canvas node per branch, labelled", () => {
    const p = parallelRun().reduce(applyEvent, loadAgents(emptyProjection(), [research]) as Projection);
    expect(["agent:research#1", "agent:research#2", "agent:research#3"].map((id) => p.nodes[id]?.label)).toEqual([
      "Research #1",
      "Research #2",
      "Research #3",
    ]);
  });

  it("strip: several dots active at once", () => {
    const evs = parallelRun();
    const all3 = stripModel({ events: evs.slice(0, 6) });
    expect(all3.dots.map((d) => d.agent_id)).toEqual(["research#1", "research#2", "research#3", "writer", "validator"]);
    expect(activeIndices(all3)).toEqual([0, 1, 2]);
    expect(all3.activeIndex).toBe(0);
    const two = stripModel({ events: evs });
    expect(activeIndices(two)).toEqual([0, 2]); // research#2 finished
  });
});
