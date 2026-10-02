/**
 * Perf harness only (?stress=N): pads the canvas to N nodes with synthetic
 * dots + edges and cycles their states. Never active unless the URL asks.
 */
import type { NodeKind, NodeState } from "@pos/schemas";
import type { Projection } from "../store/projection";
import { useGraph } from "../store/graph";
import { hash01 } from "./layout";

const KINDS: NodeKind[] = ["agent", "tool", "memory", "task", "artifact"];
const STATES: NodeState[] = ["idle", "thinking", "running", "completed", "waiting_approval", "error"];

export function stressCount(search = location.search): number {
  const n = Number(new URLSearchParams(search).get("stress"));
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 500) : 0;
}

export function startStress(target: number): () => void {
  const existing = Object.keys(useGraph.getState().nodes).length;
  const add = Math.max(0, target - existing);
  const nodes: Projection["nodes"] = {};
  const edges: Projection["edges"] = {};
  const ids: string[] = [];
  for (let i = 0; i < add; i++) {
    const id = `stress:${i}`;
    const a = i * 2.39996; // golden-angle spiral
    const r = 420 + 26 * Math.sqrt(i) * 6;
    nodes[id] = {
      id,
      kind: KINDS[i % KINDS.length],
      label: `node-${i}`,
      ref_id: id,
      state: "idle",
      position: { x: Math.cos(a) * r, y: Math.sin(a) * r * 0.7 },
    };
    if (i > 0) {
      const src = ids[Math.floor(hash01(id) * ids.length)];
      edges[`stress-e:${i}`] = { id: `stress-e:${i}`, source: src, target: id, kind: "calls", active: i % 3 === 0 };
    }
    ids.push(id);
  }
  useGraph.getState().addNodes(nodes, edges);

  let k = 0;
  const timer = setInterval(() => {
    const s = useGraph.getState();
    const next = { ...s.nodes };
    for (let j = 0; j < 5 && ids.length; j++) {
      const id = ids[(k * 5 + j) % ids.length];
      if (next[id]) next[id] = { ...next[id], state: STATES[(k + j) % STATES.length] };
    }
    k++;
    useGraph.setState({ nodes: next });
  }, 400);
  return () => clearInterval(timer);
}
