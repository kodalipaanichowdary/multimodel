import { create } from "zustand";
import { parseEvent, type AgentDefinition } from "@pos/schemas";
import {
  applyEvent,
  emptyProjection,
  loadAgents,
  type Projection,
  type XY,
} from "./projection";

export type WsStatus = "connecting" | "open" | "closed";

export interface SchemaError {
  at: string;
  issues: string;
  raw: string;
}

interface GraphStore extends Projection {
  wsStatus: WsStatus;
  schemaErrors: SchemaError[];
  agentsError: string | null;
  selectedId: string | null;
  popup: { nodeId: string; x: number; y: number } | null;

  setAgents: (list: AgentDefinition[]) => void;
  setAgentsError: (msg: string | null) => void;
  /** Entry point for every wire message. zod-validates before projecting. */
  ingest: (raw: string) => void;
  setWsStatus: (s: WsStatus) => void;
  moveNode: (id: string, pos: XY) => void;
  openPopup: (nodeId: string, x: number, y: number) => void;
  closePopup: () => void;
  select: (id: string | null) => void;
  addNodes: (nodes: Projection["nodes"], edges: Projection["edges"]) => void;
}

export const useGraph = create<GraphStore>()((set, get) => ({
  ...emptyProjection(),
  wsStatus: "connecting",
  schemaErrors: [],
  agentsError: null,
  selectedId: null,
  popup: null,

  setAgents: (list) => set((s) => ({ ...loadAgents(s, list), agentsError: null })),
  setAgentsError: (agentsError) => set({ agentsError }),

  ingest: (raw) => {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      json = undefined;
    }
    const r = parseEvent(json);
    if (!r.success) {
      const err: SchemaError = {
        at: new Date().toISOString(),
        issues: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        raw: raw.slice(0, 500),
      };
      console.warn("[ws] dropped invalid event", err);
      set((s) => ({ schemaErrors: [...s.schemaErrors.slice(-49), err] }));
      return;
    }
    const s = get();
    const next = applyEvent(s, r.data);
    if (next !== s) set(next);
  },

  setWsStatus: (wsStatus) => set({ wsStatus }),

  moveNode: (id, position) =>
    set((s) => {
      const n = s.nodes[id];
      return n ? { nodes: { ...s.nodes, [id]: { ...n, position } } } : {};
    }),

  openPopup: (nodeId, x, y) => set({ popup: { nodeId, x, y }, selectedId: nodeId }),
  closePopup: () => set({ popup: null }),
  select: (selectedId) => set({ selectedId }),
  addNodes: (nodes, edges) =>
    set((s) => ({ nodes: { ...s.nodes, ...nodes }, edges: { ...s.edges, ...edges } })),
}));

// Test/e2e hook: read-only view of the store.
if (typeof window !== "undefined") {
  (window as unknown as { __pos: unknown }).__pos = { getState: useGraph.getState };
}
