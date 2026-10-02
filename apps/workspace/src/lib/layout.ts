import type { NodeKind } from "@pos/schemas";

type XY = { x: number; y: number };

/** Deterministic 32-bit hash -> [0,1). Stable layout across reloads. */
export function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/** Orchestrator at origin; others on a ring around it. */
export function agentPositions(ids: string[], radius = 260): Record<string, XY> {
  const out: Record<string, XY> = {};
  const ring = ids.filter((id) => id !== "orchestrator");
  if (ids.includes("orchestrator")) out.orchestrator = { x: 0, y: 0 };
  ring.forEach((id, i) => {
    const a = (i / Math.max(ring.length, 1)) * Math.PI * 2 - Math.PI / 2;
    out[id] = { x: Math.cos(a) * radius, y: Math.sin(a) * radius * 0.72 };
  });
  return out;
}

const SATELLITE_DIST: Record<NodeKind, number> = {
  agent: 260,
  tool: 120,
  memory: 110,
  task: 170,
  artifact: 140,
};

/** Place a dynamic node near its anchor, angle derived from its id. */
export function satellitePosition(anchor: XY, id: string, kind: NodeKind): XY {
  const base = kind === "task" ? Math.PI : kind === "artifact" ? 0 : hash01(id) * Math.PI * 2;
  const jitter = kind === "task" || kind === "artifact" ? (hash01(id) - 0.5) * 0.6 : 0;
  const a = base + jitter;
  const r = SATELLITE_DIST[kind];
  return { x: anchor.x + Math.cos(a) * r, y: anchor.y + Math.sin(a) * r };
}
