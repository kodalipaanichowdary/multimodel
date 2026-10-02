/**
 * Pure projection: backend events -> UI graph. No side effects, no I/O.
 * The UI graph is a view; the backend's execution graph is the truth.
 */
import type {
  AgentDefinition,
  EdgeKind,
  EventOf,
  GraphEdge,
  GraphNode,
  NodeKind,
  NodeState,
  PosEvent,
} from "@pos/schemas";
import { agentPositions, satellitePosition } from "../lib/layout";

export type XY = { x: number; y: number };
export type UINode = GraphNode & { position: XY };
export type Artifact = EventOf<"artifact.created">["payload"] & { task_id: string };

export interface Projection {
  agents: Record<string, AgentDefinition>;
  nodes: Record<string, UINode>;
  edges: Record<string, GraphEdge>;
  /** Latest human-readable activity per node (thinking msg, tool args, error). */
  detail: Record<string, string>;
  artifacts: Artifact[];
  log: PosEvent[];
  lastSeq: Record<string, number>;
  activeTaskId: string | null;
}

export const LOG_LIMIT = 300;

export const agentNodeId = (id: string) => `agent:${id}`;
export const toolNodeId = (id: string) => `tool:${id}`;
export const taskNodeId = (id: string) => `task:${id}`;
export const artifactNodeId = (id: string) => `artifact:${id}`;
export const edgeId = (kind: EdgeKind, s: string, t: string) => `${kind}:${s}->${t}`;

export function emptyProjection(): Projection {
  return {
    agents: {},
    nodes: {},
    edges: {},
    detail: {},
    artifacts: [],
    log: [],
    lastSeq: {},
    activeTaskId: null,
  };
}

export function loadAgents(p: Projection, list: AgentDefinition[]): Projection {
  const pos = agentPositions(list.map((a) => a.id));
  const agents: Record<string, AgentDefinition> = {};
  const nodes = { ...p.nodes };
  for (const a of list) {
    agents[a.id] = a;
    const nid = agentNodeId(a.id);
    nodes[nid] = {
      id: nid,
      kind: "agent",
      label: a.name,
      ref_id: a.id,
      state: nodes[nid]?.state ?? "idle",
      position: nodes[nid]?.position ?? pos[a.id],
    };
  }
  return { ...p, agents, nodes };
}

// ---------- helpers (operate on mutable drafts copied once per event) ----------

type Draft = Pick<Projection, "nodes" | "edges" | "detail">;

function setState(d: Draft, nid: string, state: NodeState) {
  const n = d.nodes[nid];
  if (n && n.state !== state) d.nodes[nid] = { ...n, state };
}

function ensureNode(d: Draft, nid: string, kind: NodeKind, label: string, ref: string, near?: string) {
  if (d.nodes[nid]) return;
  const anchor = near ? d.nodes[near]?.position : undefined;
  d.nodes[nid] = {
    id: nid,
    kind,
    label,
    ref_id: ref,
    state: "idle",
    position: satellitePosition(anchor ?? { x: 0, y: 0 }, nid, kind),
  };
}

function ensureAgent(d: Draft, agentId: string): string {
  const nid = agentNodeId(agentId);
  ensureNode(d, nid, "agent", agentId, agentId, agentNodeId("orchestrator"));
  return nid;
}

function setEdge(d: Draft, kind: EdgeKind, s: string, t: string, active: boolean) {
  const id = edgeId(kind, s, t);
  const cur = d.edges[id];
  if (!cur) d.edges[id] = { id, source: s, target: t, kind, active };
  else if (cur.active !== active) d.edges[id] = { ...cur, active };
}

function parentOf(d: Draft, nid: string): string | undefined {
  return Object.values(d.edges).find((e) => e.kind === "delegates" && e.target === nid)?.source;
}

const TRANSIENT_PREFIXES = ["task:", "tool:", "artifact:"];
const isTransient = (id: string) => TRANSIENT_PREFIXES.some((p) => id.startsWith(p));
const isProjected = (id: string) => isTransient(id) || id.startsWith("agent:");

/** New task: reset agents, drop transient nodes/edges from earlier tasks. Foreign nodes untouched. */
function resetForTask(d: Draft) {
  for (const [id, n] of Object.entries(d.nodes)) {
    if (id.startsWith("agent:")) d.nodes[id] = { ...n, state: "idle" };
    else if (isTransient(id)) delete d.nodes[id];
  }
  for (const e of Object.values(d.edges)) {
    if (isProjected(e.source) && isProjected(e.target)) delete d.edges[e.id];
  }
  for (const id of Object.keys(d.detail)) if (isProjected(id)) delete d.detail[id];
}

// ---------- reducer ----------

export function applyEvent(p: Projection, ev: PosEvent): Projection {
  const last = p.lastSeq[ev.task_id];
  if (last !== undefined && ev.seq <= last) return p; // duplicate / stale

  const d: Draft = { nodes: { ...p.nodes }, edges: { ...p.edges }, detail: { ...p.detail } };
  let artifacts = p.artifacts;
  let activeTaskId = p.activeTaskId;
  const taskNid = taskNodeId(ev.task_id);

  switch (ev.type) {
    case "task.created": {
      resetForTask(d);
      activeTaskId = ev.task_id;
      const orch = ensureAgent(d, "orchestrator");
      ensureNode(d, taskNid, "task", "Task", ev.task_id, orch);
      setState(d, taskNid, "running");
      d.detail[taskNid] = ev.payload.prompt;
      setEdge(d, "delegates", taskNid, orch, true);
      break;
    }
    case "task.planned": {
      const orch = ensureAgent(d, "orchestrator");
      for (const step of ev.payload.steps) {
        const a = ensureAgent(d, step.agent_id);
        setState(d, a, "queued");
        d.detail[a] = step.goal;
        setEdge(d, "delegates", orch, a, false);
      }
      break;
    }
    case "agent.started": {
      const a = ensureAgent(d, ev.payload.agent_id);
      setState(d, a, "running");
      if (ev.payload.parent_id) setEdge(d, "delegates", ensureAgent(d, ev.payload.parent_id), a, true);
      break;
    }
    case "agent.thinking": {
      const a = ensureAgent(d, ev.payload.agent_id);
      setState(d, a, "thinking");
      d.detail[a] = ev.payload.message;
      break;
    }
    case "agent.completed": {
      const a = ensureAgent(d, ev.payload.agent_id);
      setState(d, a, "completed");
      d.detail[a] = ev.payload.summary;
      const parent = parentOf(d, a);
      if (parent) setEdge(d, "delegates", parent, a, false);
      break;
    }
    case "tool.started": {
      const a = ensureAgent(d, ev.payload.agent_id);
      const t = toolNodeId(ev.payload.tool_id);
      ensureNode(d, t, "tool", ev.payload.tool_id, ev.payload.tool_id, a);
      setState(d, t, "running");
      setState(d, a, "running");
      d.detail[t] = JSON.stringify(ev.payload.args);
      setEdge(d, "calls", a, t, true);
      break;
    }
    case "tool.completed": {
      const a = ensureAgent(d, ev.payload.agent_id);
      const t = toolNodeId(ev.payload.tool_id);
      ensureNode(d, t, "tool", ev.payload.tool_id, ev.payload.tool_id, a);
      setState(d, t, "completed");
      d.detail[t] = `${ev.payload.result_preview} (${ev.payload.duration_ms} ms)`;
      setEdge(d, "calls", a, t, false);
      break;
    }
    case "tool.failed": {
      const a = ensureAgent(d, ev.payload.agent_id);
      const t = toolNodeId(ev.payload.tool_id);
      ensureNode(d, t, "tool", ev.payload.tool_id, ev.payload.tool_id, a);
      setState(d, t, "error");
      setState(d, a, "error");
      d.detail[t] = ev.payload.error;
      d.detail[a] = `tool ${ev.payload.tool_id} failed: ${ev.payload.error}`;
      setEdge(d, "calls", a, t, false);
      break;
    }
    case "approval.requested": {
      const a = ensureAgent(d, ev.payload.agent_id);
      setState(d, a, "waiting_approval");
      d.detail[a] = `approval: ${ev.payload.tool_id} — ${ev.payload.reason}`;
      break;
    }
    case "approval.granted": {
      const req = [...p.log]
        .reverse()
        .find(
          (e): e is EventOf<"approval.requested"> =>
            e.type === "approval.requested" && e.payload.approval_id === ev.payload.approval_id,
        );
      if (req) setState(d, agentNodeId(req.payload.agent_id), "running");
      break;
    }
    case "artifact.created": {
      const a = ensureAgent(d, ev.payload.agent_id);
      const nid = artifactNodeId(ev.payload.artifact_id);
      ensureNode(d, nid, "artifact", ev.payload.title, ev.payload.artifact_id, a);
      setState(d, nid, "completed");
      setEdge(d, "produces", a, nid, true);
      artifacts = [...artifacts, { ...ev.payload, task_id: ev.task_id }];
      break;
    }
    case "execution.completed": {
      setState(d, taskNid, "completed");
      d.detail[taskNid] = `completed in ${ev.payload.duration_ms} ms`;
      for (const e of Object.values(d.edges)) if (e.active) d.edges[e.id] = { ...e, active: false };
      break;
    }
    case "execution.failed": {
      setState(d, taskNid, "error");
      d.detail[taskNid] = ev.payload.error;
      if (ev.payload.agent_id) setState(d, ensureAgent(d, ev.payload.agent_id), "error");
      for (const n of Object.values(d.nodes)) {
        if (n.kind === "agent" && (n.state === "running" || n.state === "thinking")) {
          setState(d, n.id, "error");
        }
      }
      for (const e of Object.values(d.edges)) if (e.active) d.edges[e.id] = { ...e, active: false };
      break;
    }
  }

  const log = p.log.length >= LOG_LIMIT ? [...p.log.slice(1), ev] : [...p.log, ev];
  return {
    ...p,
    ...d,
    artifacts,
    activeTaskId,
    log,
    lastSeq: { ...p.lastSeq, [ev.task_id]: ev.seq },
  };
}
