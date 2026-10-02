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

/**
 * Node footprint in flow units: dot plus its label underneath. Two nodes overlap
 * when their centres are closer than this box on both axes.
 */
export const FOOTPRINT = { w: 96, h: 56 };

export function overlaps(a: XY, b: XY): boolean {
  return Math.abs(a.x - b.x) < FOOTPRINT.w && Math.abs(a.y - b.y) < FOOTPRINT.h;
}

const SATELLITE_DIST: Record<NodeKind, number> = {
  agent: 260,
  tool: 120,
  memory: 110,
  task: 170,
  artifact: 140,
};

/** Preferred direction: tasks to the left, artifacts to the right, tools outward from the hub. */
function baseAngle(anchor: XY, center: XY, id: string, kind: NodeKind): number {
  if (kind === "task") return Math.PI;
  if (kind === "artifact") return 0;
  const dx = anchor.x - center.x;
  const dy = anchor.y - center.y;
  const outward = dx === 0 && dy === 0 ? hash01(id) * Math.PI * 2 : Math.atan2(dy, dx);
  return outward + (hash01(id) - 0.5) * 0.5;
}

/**
 * Place a dynamic node near its anchor without overlapping `occupied`.
 * Tries the preferred angle, then fans out ±30° steps, then larger radii.
 * Deterministic for the same inputs.
 */
export function placeSatellite(
  anchor: XY,
  id: string,
  kind: NodeKind,
  occupied: XY[],
  center: XY = { x: 0, y: 0 },
): XY {
  const base = baseAngle(anchor, center, id, kind);
  const r0 = SATELLITE_DIST[kind];
  const step = Math.PI / 6;
  for (const rMul of [1, 1.35, 1.7, 2.1, 2.6]) {
    for (let k = 0; k <= 6; k++) {
      for (const sign of k === 0 ? [1] : [1, -1]) {
        const a = base + sign * k * step;
        const p = { x: anchor.x + Math.cos(a) * r0 * rMul, y: anchor.y + Math.sin(a) * r0 * rMul };
        if (!occupied.some((o) => overlaps(o, p))) return p;
      }
    }
  }
  // Dense graph: fall back to the preferred spot rather than fly off-screen.
  return { x: anchor.x + Math.cos(base) * r0, y: anchor.y + Math.sin(base) * r0 };
}
