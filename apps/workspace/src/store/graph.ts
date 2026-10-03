import { create } from "zustand";
import { parseEvent, type AgentDefinition } from "@pos/schemas";
import {
  applyEvent,
  emptyProjection,
  loadAgents,
  recordInvalid,
  type Projection,
  type XY,
} from "./projection";

export type WsStatus = "connecting" | "open" | "closed";
export type DockTab = "chat" | "run" | "inspect";
export type InspectorTab = "node" | "events" | "artifacts";

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
  // UI-only state (never derived from or fed back into events)
  dockTab: DockTab;
  inspectorTab: InspectorTab;
  highlightArtifact: string | null;
  /** Agents flagged `selected` for the next POST /tasks. */
  nextSelected: string[];
  /** Run shown in the Run tab; null = latest. */
  runViewTask: string | null;
  addAgentOpen: boolean;
  /** Unsent composer text (UI-only; survives layout switches). */
  draft: string;
  setDraft: (text: string) => void;
  /**
   * Per run: browser receive time - server ts of the first event seen. Lets live
   * elapsed be expressed in server time without mixing clocks (see liveStats).
   */
  clockOffsets: Record<string, number>;

  setAgents: (list: AgentDefinition[]) => void;
  setAgentsError: (msg: string | null) => void;
  /** Entry point for every wire message. zod-validates before projecting. */
  ingest: (raw: string, opts?: { history?: boolean }) => void;
  setWsStatus: (s: WsStatus) => void;
  moveNode: (id: string, pos: XY) => void;
  openPopup: (nodeId: string, x: number, y: number) => void;
  closePopup: () => void;
  select: (id: string | null) => void;
  addNodes: (nodes: Projection["nodes"], edges: Projection["edges"]) => void;
  setDockTab: (t: DockTab) => void;
  setInspectorTab: (t: InspectorTab) => void;
  openArtifact: (artifactId: string) => void;
  toggleSelected: (agentId: string) => void;
  clearSelected: () => void;
  setRunViewTask: (id: string | null) => void;
  setAddAgentOpen: (open: boolean) => void;
}

export const useGraph = create<GraphStore>()((set, get) => ({
  ...emptyProjection(),
  wsStatus: "connecting",
  schemaErrors: [],
  agentsError: null,
  selectedId: null,
  popup: null,
  dockTab: "chat",
  inspectorTab: "events",
  highlightArtifact: null,
  nextSelected: [],
  runViewTask: null,
  addAgentOpen: false,
  draft: "",
  setDraft: (draft) => set({ draft }),
  clockOffsets: {},

  setAgents: (list) => set((s) => ({ ...loadAgents(s, list), agentsError: null })),
  setAgentsError: (agentsError) => set({ agentsError }),

  ingest: (raw, opts) => {
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
      set((s) => ({ ...recordInvalid(s), schemaErrors: [...s.schemaErrors.slice(-49), err] }));
      return;
    }
    const s = get();
    const next = applyEvent(s, r.data);
    if (next === s) return;
    const ev = r.data;
    // Live frames capture the browser-vs-server offset from a run's first event. Restored
    // history arrives late, so receipt time says nothing about the server clock: use 0.
    const clockOffsets =
      ev.task_id in s.clockOffsets
        ? s.clockOffsets
        : { ...s.clockOffsets, [ev.task_id]: opts?.history ? 0 : Date.now() - Date.parse(ev.ts) };
    // A new run brings the chat forward.
    set(
      ev.type === "task.created"
        ? { ...next, clockOffsets, dockTab: "chat", runViewTask: null }
        : { ...next, clockOffsets },
    );
  },

  setWsStatus: (wsStatus) => set({ wsStatus }),

  moveNode: (id, position) =>
    set((s) => {
      const n = s.nodes[id];
      return n ? { nodes: { ...s.nodes, [id]: { ...n, position } } } : {};
    }),

  // Clicking a node inspects it.
  openPopup: (nodeId, x, y) =>
    set({ popup: { nodeId, x, y }, selectedId: nodeId, dockTab: "inspect", inspectorTab: "node" }),
  closePopup: () => set({ popup: null }),
  select: (selectedId) => set({ selectedId }),
  addNodes: (nodes, edges) =>
    set((s) => ({ nodes: { ...s.nodes, ...nodes }, edges: { ...s.edges, ...edges } })),
  setDockTab: (dockTab) => set({ dockTab }),
  setInspectorTab: (inspectorTab) => set({ inspectorTab }),
  openArtifact: (id) =>
    set({ dockTab: "inspect", inspectorTab: "artifacts", selectedId: null, highlightArtifact: id }),
  toggleSelected: (id) =>
    set((s) => ({
      nextSelected: s.nextSelected.includes(id)
        ? s.nextSelected.filter((x) => x !== id)
        : [...s.nextSelected, id],
    })),
  clearSelected: () => set({ nextSelected: [] }),
  setRunViewTask: (runViewTask) => set({ runViewTask }),
  setAddAgentOpen: (addAgentOpen) => set({ addAgentOpen }),
}));

// Test/e2e hook: read-only view of the store.
if (typeof window !== "undefined") {
  (window as unknown as { __pos: unknown }).__pos = { getState: useGraph.getState };
}
