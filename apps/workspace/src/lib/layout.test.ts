import { describe, expect, it } from "vitest";
import { EventSchema, type AgentDefinition, type PosEvent } from "@pos/schemas";
import sequences from "../../../../packages/schemas/fixtures/mock_sequences.json";
import { applyEvent, emptyProjection, loadAgents, type Projection } from "../store/projection";
import { FOOTPRINT, overlaps, placeSatellite } from "./layout";

const agent = (id: string): AgentDefinition => ({
  id,
  name: id,
  description: "d",
  capabilities: ["c"],
  tools: [],
  memory: { scope: "task", kind: "none" },
  model_profile: { provider: "ollama", model: "m", temperature: 0, max_tokens: 1 },
  permissions: [],
});
// Same order GET /agents returns (manifests sorted by directory name).
const DEFAULT = ["coder", "memory", "orchestrator", "research", "validator", "writer"].map(agent);
const HAPPY: PosEvent[] = sequences.happy.map((e) => EventSchema.parse(e));
const FAIL: PosEvent[] = sequences.fail.map((e) => EventSchema.parse(e));

function overlappingPairs(p: Projection): string[] {
  const nodes = Object.values(p.nodes);
  const bad: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (overlaps(nodes[i].position, nodes[j].position)) bad.push(`${nodes[i].id} x ${nodes[j].id}`);
    }
  }
  return bad;
}

describe("default layout has no overlapping nodes", () => {
  it("after a full happy run (task, tools, artifact near Writer)", () => {
    const p = HAPPY.reduce(applyEvent, loadAgents(emptyProjection(), DEFAULT));
    expect(Object.keys(p.nodes)).toHaveLength(10);
    expect(overlappingPairs(p)).toEqual([]);
  });

  it("after the fail run", () => {
    const p = FAIL.reduce(applyEvent, loadAgents(emptyProjection(), DEFAULT));
    expect(overlappingPairs(p)).toEqual([]);
  });

  it("after adding agents later and running again", () => {
    let p = loadAgents(emptyProjection(), DEFAULT);
    p = loadAgents(p, [...DEFAULT, agent("critic"), agent("planner"), agent("editor")]);
    p = HAPPY.reduce(applyEvent, p);
    expect(overlappingPairs(p)).toEqual([]);
  });

  it("min centre separation >= footprint on at least one axis for every pair", () => {
    const p = HAPPY.reduce(applyEvent, loadAgents(emptyProjection(), DEFAULT));
    const ns = Object.values(p.nodes);
    for (const a of ns)
      for (const b of ns) {
        if (a === b) continue;
        const dx = Math.abs(a.position.x - b.position.x);
        const dy = Math.abs(a.position.y - b.position.y);
        expect(dx >= FOOTPRINT.w || dy >= FOOTPRINT.h, `${a.id} vs ${b.id}`).toBe(true);
      }
  });
});

describe("placeSatellite", () => {
  it("is deterministic", () => {
    const occ = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
    expect(placeSatellite({ x: 100, y: 0 }, "tool:x", "tool", occ)).toEqual(
      placeSatellite({ x: 100, y: 0 }, "tool:x", "tool", occ),
    );
  });

  it("steps around a crowded anchor instead of overlapping", () => {
    const anchor = { x: 0, y: 0 };
    const occ = [anchor];
    for (let i = 0; i < 12; i++) occ.push(placeSatellite(anchor, `tool:t${i}`, "tool", occ));
    for (let i = 0; i < occ.length; i++)
      for (let j = i + 1; j < occ.length; j++) expect(overlaps(occ[i], occ[j])).toBe(false);
  });
});
