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
import { agentPositions, placeSatellite } from "../lib/layout";

export type XY = { x: number; y: number };
export type UINode = GraphNode & { position: XY };
export type Artifact = EventOf<"artifact.created">["payload"] & { task_id: string };

export type RunStatus = "running" | "completed" | "failed";

/** Every event of one task, in seq order. The single source for chat, run view and scorecard. */
export interface Run {
  task_id: string;
  prompt: string;
  events: PosEvent[];
  /** Wire frames rejected by zod while this run was active. */
  invalidDropped: number;
}

export type ChatTone = "info" | "running" | "done" | "warn" | "error";
export type ChatItem =
  | { id: string; kind: "user"; task_id: string; text: string }
  | { id: string; kind: "status"; task_id: string; text: string; tone: ChatTone }
  | { id: string; kind: "result"; task_id: string; artifact: Artifact }
  | { id: string; kind: "error"; task_id: string; agent_id: string | null; tool_id: string | null; error: string }
  | {
      id: string;
      kind: "approval";
      task_id: string;
      approval_id: string;
      agent_id: string;
      tool_id: string;
      reason: string;
      status: ApprovalStatus;
      by: string | null;
    };

export type ApprovalStatus = "pending" | "granted" | "denied" | "cancelled";

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
  runs: Record<string, Run>;
  /** task ids, oldest first */
  runOrder: string[];
  /** Session chat history; survives new tasks (never reset). */
  chat: ChatItem[];
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
    runs: {},
    runOrder: [],
    chat: [],
  };
}

export function loadAgents(p: Projection, list: AgentDefinition[]): Projection {
  const initial = !Object.keys(p.nodes).some((id) => id.startsWith("agent:"));
  const pos = agentPositions(list.map((a) => a.id));
  const agents: Record<string, AgentDefinition> = {};
  const nodes = { ...p.nodes };
  for (const a of list) {
    agents[a.id] = a;
    const nid = agentNodeId(a.id);
    const prev = nodes[nid];
    nodes[nid] = {
      id: nid,
      kind: "agent",
      label: a.name,
      ref_id: a.id,
      state: prev?.state ?? "idle",
      // Agents added later go on an outer ring so they never land on existing nodes.
      // Agents added later are placed clear of everything already on the canvas.
      position:
        prev?.position ??
        (initial
          ? pos[a.id]
          : placeSatellite({ x: 0, y: 0 }, nid, "agent", Object.values(nodes).map((n) => n.position))),
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
    position: placeSatellite(
      anchor ?? { x: 0, y: 0 },
      nid,
      kind,
      Object.values(d.nodes).map((n) => n.position),
      d.nodes[agentNodeId("orchestrator")]?.position,
    ),
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
    case "approval.denied": {
      const req = [...p.log]
        .reverse()
        .find(
          (e): e is EventOf<"approval.requested"> =>
            e.type === "approval.requested" && e.payload.approval_id === ev.payload.approval_id,
        );
      if (req) {
        setState(d, agentNodeId(req.payload.agent_id), "running");
        d.detail[agentNodeId(req.payload.agent_id)] = `approval denied (${ev.payload.by}): ${req.payload.tool_id}`;
      }
      break;
    }
    case "model.metrics": {
      const a = ensureAgent(d, ev.payload.agent_id);
      d.detail[a] = `${ev.payload.model} · TTFT ${ev.payload.ttft_ms} ms · ${ev.payload.tok_s} tok/s`;
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
  const prevRun = p.runs[ev.task_id];
  const run: Run = prevRun
    ? { ...prevRun, events: [...prevRun.events, ev] }
    : {
        task_id: ev.task_id,
        prompt: ev.type === "task.created" ? ev.payload.prompt : "(unknown task)",
        events: [ev],
        invalidDropped: 0,
      };
  return {
    ...p,
    ...d,
    artifacts,
    activeTaskId,
    log,
    lastSeq: { ...p.lastSeq, [ev.task_id]: ev.seq },
    runs: { ...p.runs, [ev.task_id]: run },
    runOrder: prevRun ? p.runOrder : [...p.runOrder, ev.task_id],
    chat: projectChat(p.chat, ev, run, p.agents),
  };
}

/** A zod-rejected frame arrived; attribute it to the active, unfinished run. */
export function recordInvalid(p: Projection): Projection {
  const id = p.activeTaskId;
  const run = id ? p.runs[id] : undefined;
  if (!run || runStatus(run) !== "running") return p;
  return { ...p, runs: { ...p.runs, [run.task_id]: { ...run, invalidDropped: run.invalidDropped + 1 } } };
}

// ---------- chat (projected from events) ----------

function upsert(chat: ChatItem[], item: ChatItem): ChatItem[] {
  const i = chat.findIndex((c) => c.id === item.id);
  if (i === -1) return [...chat, item];
  const next = chat.slice();
  next[i] = item;
  return next;
}

const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function projectChat(
  chat: ChatItem[],
  ev: PosEvent,
  run: Run,
  agents: Record<string, AgentDefinition>,
): ChatItem[] {
  const t = ev.task_id;
  const name = (id: string) => agents[id]?.name ?? id;
  const status = (key: string, text: string, tone: ChatTone) =>
    upsert(chat, { id: `${t}:${key}`, kind: "status", task_id: t, text, tone });
  switch (ev.type) {
    case "task.created":
      return upsert(chat, { id: `${t}:user`, kind: "user", task_id: t, text: ev.payload.prompt });
    case "task.planned":
      return status("plan", `Plan: ${ev.payload.steps.map((s) => name(s.agent_id)).join(" → ")}`, "info");
    case "agent.started":
      return status(`agent:${ev.payload.agent_id}`, `${name(ev.payload.agent_id)} started`, "running");
    case "agent.completed": {
      const started = run.events.find(
        (e) => e.type === "agent.started" && e.payload.agent_id === ev.payload.agent_id,
      );
      const took = started ? ` (${sec(Date.parse(ev.ts) - Date.parse(started.ts))})` : "";
      return status(`agent:${ev.payload.agent_id}`, `${name(ev.payload.agent_id)} done${took}`, "done");
    }
    case "tool.started":
      return status(`tool:${ev.payload.call_id}`, `${ev.payload.tool_id} running`, "running");
    case "tool.completed":
      return status(
        `tool:${ev.payload.call_id}`,
        `${ev.payload.tool_id} done (${ev.payload.duration_ms} ms)`,
        "done",
      );
    case "tool.failed":
      return status(`tool:${ev.payload.call_id}`, `${ev.payload.tool_id} failed: ${ev.payload.error}`, "error");
    case "approval.requested":
      return upsert(chat, {
        id: `${t}:appr:${ev.payload.approval_id}`,
        kind: "approval",
        task_id: t,
        approval_id: ev.payload.approval_id,
        agent_id: ev.payload.agent_id,
        tool_id: ev.payload.tool_id,
        reason: ev.payload.reason,
        status: "pending",
        by: null,
      });
    case "approval.granted":
    case "approval.denied": {
      const id = `${t}:appr:${ev.payload.approval_id}`;
      const card = chat.find((c) => c.id === id);
      if (!card || card.kind !== "approval") return chat;
      return upsert(chat, { ...card, status: ev.type === "approval.granted" ? "granted" : "denied", by: ev.payload.by });
    }
    case "artifact.created":
      return upsert(chat, {
        id: `${t}:result:${ev.payload.artifact_id}`,
        kind: "result",
        task_id: t,
        artifact: { ...ev.payload, task_id: t },
      });
    case "execution.failed": {
      const failedTool = [...run.events]
        .reverse()
        .find((e): e is EventOf<"tool.failed"> => e.type === "tool.failed");
      const settled = chat.map((c): ChatItem => {
        if (c.task_id !== t) return c;
        if (c.kind === "status" && c.tone === "running") return { ...c, tone: "error" };
        if (c.kind === "approval" && c.status === "pending") return { ...c, status: "cancelled" };
        return c;
      });
      return upsert(settled, {
        id: `${t}:error`,
        kind: "error",
        task_id: t,
        agent_id: ev.payload.agent_id ?? failedTool?.payload.agent_id ?? null,
        tool_id: failedTool?.payload.tool_id ?? null,
        error: failedTool ? `${ev.payload.error} — ${failedTool.payload.error}` : ev.payload.error,
      });
    }
    default:
      return chat;
  }
}

// ---------- scorecard + timeline (pure, derived from Run.events only) ----------

export function runStatus(run: Pick<Run, "events">): RunStatus {
  const last = run.events.at(-1);
  if (last?.type === "execution.completed") return "completed";
  if (last?.type === "execution.failed") return "failed";
  return "running";
}

export interface Scorecard {
  agents_used: number;
  tools_called: number;
  tools_failed: number;
  approvals: number;
  events_total: number;
  events_invalid_dropped: number;
  duration_ms: number;
  status: RunStatus;
}

export function scorecard(run: Pick<Run, "events" | "invalidDropped">): Scorecard {
  const ev = run.events;
  const count = (type: PosEvent["type"]) => ev.filter((e) => e.type === type).length;
  const agents = new Set(ev.flatMap((e) => (e.type === "agent.started" ? [e.payload.agent_id] : [])));
  const done = ev.find((e): e is EventOf<"execution.completed"> => e.type === "execution.completed");
  const span = ev.length > 1 ? Date.parse(ev[ev.length - 1].ts) - Date.parse(ev[0].ts) : 0;
  return {
    agents_used: agents.size,
    tools_called: count("tool.started"),
    tools_failed: count("tool.failed"),
    approvals: count("approval.requested"),
    events_total: ev.length,
    events_invalid_dropped: run.invalidDropped,
    duration_ms: done ? done.payload.duration_ms : span,
    status: runStatus(run),
  };
}

export type ChipStatus = "running" | "completed" | "failed";
export interface ToolChip {
  call_id: string;
  tool_id: string;
  status: ChipStatus;
  duration_ms: number | null;
}
export interface TimelineRow {
  agent_id: string;
  state: NodeState;
  /** ms from run start; null while only planned */
  started_ms: number | null;
  duration_ms: number | null;
  tools: ToolChip[];
}
export interface Timeline {
  start_ts: number | null;
  last_ts: number | null;
  rows: TimelineRow[];
}

export function runTimeline(run: Pick<Run, "events">): Timeline {
  const ev = run.events;
  const start = ev.length ? Date.parse(ev[0].ts) : null;
  const rows = new Map<string, TimelineRow>();
  const row = (id: string) => {
    let r = rows.get(id);
    if (!r) {
      r = { agent_id: id, state: "queued", started_ms: null, duration_ms: null, tools: [] };
      rows.set(id, r);
    }
    return r;
  };
  const at = (e: PosEvent) => Date.parse(e.ts) - (start ?? 0);
  const chip = (r: TimelineRow, call: string) => r.tools.find((c) => c.call_id === call);

  for (const e of ev) {
    switch (e.type) {
      case "task.planned":
        for (const s of e.payload.steps) row(s.agent_id);
        break;
      case "agent.started": {
        const r = row(e.payload.agent_id);
        r.state = "running";
        r.started_ms = at(e);
        break;
      }
      case "agent.thinking":
        row(e.payload.agent_id).state = "thinking";
        break;
      case "agent.completed": {
        const r = row(e.payload.agent_id);
        r.state = "completed";
        if (r.started_ms !== null) r.duration_ms = at(e) - r.started_ms;
        break;
      }
      case "approval.requested":
        row(e.payload.agent_id).state = "waiting_approval";
        break;
      case "approval.granted":
      case "approval.denied":
        for (const r of rows.values()) if (r.state === "waiting_approval") r.state = "running";
        break;
      case "tool.started": {
        const r = row(e.payload.agent_id);
        r.state = "running";
        r.tools.push({
          call_id: e.payload.call_id,
          tool_id: e.payload.tool_id,
          status: "running",
          duration_ms: null,
        });
        break;
      }
      case "tool.completed": {
        const c = chip(row(e.payload.agent_id), e.payload.call_id);
        if (c) Object.assign(c, { status: "completed", duration_ms: e.payload.duration_ms });
        break;
      }
      case "tool.failed": {
        const r = row(e.payload.agent_id);
        const c = chip(r, e.payload.call_id);
        if (c) c.status = "failed";
        r.state = "error";
        break;
      }
      case "execution.failed":
        for (const r of rows.values()) {
          if (r.state === "running" || r.state === "thinking" || r.state === "waiting_approval") {
            r.state = "error";
          }
        }
        break;
      default:
        break;
    }
  }
  const last = ev.length ? Date.parse(ev[ev.length - 1].ts) : null;
  return { start_ts: start, last_ts: last, rows: [...rows.values()] };
}

// ---------- live strip + summary chip (pure, derived from Run.events only) ----------

export interface LiveStats {
  tools_running: number;
  tools_done: number;
  tools_failed: number;
  /** events in the trailing 2 s window, per second */
  events_per_sec: number;
  elapsed_ms: number;
  done: boolean;
  /** latest model call (model.metrics); null until the first one */
  model: { agent_id: string; name: string; ttft_ms: number; tok_s: number } | null;
  model_calls: number;
}

export const EVPS_WINDOW_MS = 2000;

/**
 * Run counters. Time is always in the server's clock domain:
 * - finished: last event ts - first event ts (browser clock not involved);
 * - live: `nowMs - clockOffsetMs` maps the browser clock onto server time, where
 *   clockOffsetMs = (browser receive time - server ts) of the run's first event.
 */
export function liveStats(run: Pick<Run, "events">, nowMs: number, clockOffsetMs: number): LiveStats {
  const ev = run.events;
  const done = runStatus(run) !== "running";
  if (ev.length === 0) {
    return { tools_running: 0, tools_done: 0, tools_failed: 0, events_per_sec: 0, elapsed_ms: 0, done, model: null, model_calls: 0 };
  }
  const first = Date.parse(ev[0].ts);
  const last = Date.parse(ev[ev.length - 1].ts);
  const serverNow = done ? last : Math.max(last, nowMs - clockOffsetMs);
  const settled = new Set<string>();
  let started = 0;
  let completed = 0;
  let failed = 0;
  let inWindow = 0;
  let model: LiveStats["model"] = null;
  let modelCalls = 0;
  for (const e of ev) {
    if (e.type === "model.metrics") {
      modelCalls++;
      model = { agent_id: e.payload.agent_id, name: e.payload.model, ttft_ms: e.payload.ttft_ms, tok_s: e.payload.tok_s };
    }
    if (e.type === "tool.started") started++;
    if (e.type === "tool.completed") {
      completed++;
      settled.add(e.payload.call_id);
    }
    if (e.type === "tool.failed") {
      failed++;
      settled.add(e.payload.call_id);
    }
    if (Date.parse(e.ts) > serverNow - EVPS_WINDOW_MS) inWindow++;
  }
  return {
    tools_running: Math.max(0, started - settled.size),
    tools_done: completed,
    tools_failed: failed,
    events_per_sec: inWindow / (EVPS_WINDOW_MS / 1000),
    elapsed_ms: serverNow - first,
    done,
    model,
    model_calls: modelCalls,
  };
}

export interface StripDot {
  agent_id: string;
  state: NodeState;
}
export interface StripModel {
  /** planned agents, in plan order */
  dots: StripDot[];
  /** dot the pulse sits on: first active dot, else first errored dot, else -1 */
  activeIndex: number;
  /** filled fraction of the line: segment i fills when dot i completes (leading run) */
  progress: number;
}

const ACTIVE: ReadonlySet<NodeState> = new Set(["running", "thinking", "waiting_approval"]);

export function stripModel(run: Pick<Run, "events">): StripModel {
  const plan = [...run.events].reverse().find((e): e is EventOf<"task.planned"> => e.type === "task.planned");
  if (!plan) return { dots: [], activeIndex: -1, progress: 0 };
  const rows = new Map(runTimeline(run).rows.map((r) => [r.agent_id, r.state]));
  const dots = plan.payload.steps.map((s) => ({ agent_id: s.agent_id, state: rows.get(s.agent_id) ?? "queued" }));
  let activeIndex = dots.findIndex((d) => ACTIVE.has(d.state));
  if (activeIndex === -1) activeIndex = dots.findIndex((d) => d.state === "error");
  let leading = 0;
  while (leading < dots.length && dots[leading].state === "completed") leading++;
  const progress = dots.length <= 1 ? (leading > 0 ? 1 : 0) : Math.min(leading, dots.length - 1) / (dots.length - 1);
  return { dots, activeIndex, progress };
}

export interface StripSummary {
  ok: boolean;
  agents: number;
  tools: number;
  seconds: string;
  /** "✓ 4 agents · 2 tools · 5.3s" */
  text: string;
}

/** One-line chip for a finished run. Duration from event timestamps only. */
export function stripSummary(run: Pick<Run, "events" | "invalidDropped">): StripSummary {
  const sc = scorecard(run);
  const ev = run.events;
  const span = ev.length > 1 ? Date.parse(ev[ev.length - 1].ts) - Date.parse(ev[0].ts) : 0;
  const ok = sc.status === "completed";
  const seconds = `${(span / 1000).toFixed(1)}s`;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  return {
    ok,
    agents: sc.agents_used,
    tools: sc.tools_called,
    seconds,
    text: `${ok ? "✓" : "✗"} ${plural(sc.agents_used, "agent")} · ${plural(sc.tools_called, "tool")} · ${seconds}`,
  };
}
