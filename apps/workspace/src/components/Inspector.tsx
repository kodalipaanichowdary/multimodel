import { useState, type ReactNode } from "react";
import type { PosEvent } from "@pos/schemas";
import { useGraph } from "../store/graph";
import { KIND_COLOR, STATE_COLOR } from "../lib/theme";

type Tab = "node" | "events" | "artifacts";

export function Inspector() {
  const [tab, setTab] = useState<Tab>("events");
  const selectedId = useGraph((s) => s.selectedId);
  const logLen = useGraph((s) => s.log.length);
  const artifactsLen = useGraph((s) => s.artifacts.length);
  const schemaErrors = useGraph((s) => s.schemaErrors.length);
  const active = selectedId ? "node" : tab === "node" ? "events" : tab;

  return (
    <aside
      data-testid="inspector"
      className="absolute bottom-0 right-0 top-0 z-30 flex w-[340px] flex-col border-l border-white/5 bg-[#0a0b10]/90 backdrop-blur"
    >
      <header className="flex items-center gap-1 border-b border-white/5 px-3 py-2 text-xs">
        <span className="mr-2 font-semibold tracking-wide text-slate-300">Inspector</span>
        <TabBtn on={active === "node"} onClick={() => setTab("node")} disabled={!selectedId}>
          Node
        </TabBtn>
        <TabBtn on={active === "events"} onClick={() => { useGraph.getState().select(null); setTab("events"); }}>
          Events <span className="text-slate-500">{logLen}</span>
        </TabBtn>
        <TabBtn on={active === "artifacts"} onClick={() => { useGraph.getState().select(null); setTab("artifacts"); }}>
          Artifacts <span className="text-slate-500">{artifactsLen}</span>
        </TabBtn>
        {schemaErrors > 0 && (
          <span className="ml-auto rounded bg-red-500/15 px-1.5 text-[10px] text-red-300" data-testid="schema-errors">
            {schemaErrors} invalid
          </span>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 text-xs">
        {active === "node" && selectedId && <NodeDetail id={selectedId} />}
        {active === "events" && <EventLog />}
        {active === "artifacts" && <Artifacts />}
      </div>
    </aside>
  );
}

function TabBtn(props: { on: boolean; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      disabled={props.disabled}
      onClick={props.onClick}
      className={`rounded px-2 py-1 ${props.on ? "bg-white/10 text-slate-100" : "text-slate-400 hover:text-slate-200"} disabled:opacity-30`}
    >
      {props.children}
    </button>
  );
}

function NodeDetail({ id }: { id: string }) {
  const node = useGraph((s) => s.nodes[id]);
  const detail = useGraph((s) => s.detail[id]);
  const log = useGraph((s) => s.log);
  if (!node) return <p className="text-slate-500">Node no longer present.</p>;
  const related = log.filter((e) => touches(e, node.ref_id)).slice(-30).reverse();
  return (
    <div data-testid="inspector-node">
      <div className="mb-2 flex items-center gap-2">
        <span className="h-3 w-3 rounded-full" style={{ background: KIND_COLOR[node.kind] }} />
        <span className="text-sm font-semibold">{node.label}</span>
        <span className="ml-auto" style={{ color: STATE_COLOR[node.state] }} data-testid="inspector-state">
          {node.state}
        </span>
      </div>
      <dl className="mb-3 grid grid-cols-[70px_1fr] gap-y-1 text-slate-400">
        <dt>id</dt>
        <dd className="font-mono text-slate-300">{node.id}</dd>
        <dt>kind</dt>
        <dd className="text-slate-300">{node.kind}</dd>
        {detail && (
          <>
            <dt>latest</dt>
            <dd className="text-slate-300">{detail}</dd>
          </>
        )}
      </dl>
      <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">Related events</div>
      <EventRows events={related} />
    </div>
  );
}

function touches(e: PosEvent, ref: string): boolean {
  if (e.task_id === ref) return true;
  const p = e.payload as Record<string, unknown>;
  return p.agent_id === ref || p.tool_id === ref || p.artifact_id === ref || p.parent_id === ref;
}

function EventLog() {
  const log = useGraph((s) => s.log);
  return <EventRows events={[...log].reverse()} testid="event-log" />;
}

const TYPE_COLOR: Record<string, string> = {
  task: "#38bdf8",
  agent: "#a78bfa",
  tool: "#fbbf24",
  approval: "#f59e0b",
  artifact: "#34d399",
  execution: "#10b981",
};

function EventRows({ events, testid }: { events: PosEvent[]; testid?: string }) {
  if (events.length === 0) return <p className="text-slate-600">No events yet. Run a task below.</p>;
  return (
    <ol className="space-y-1 font-mono" data-testid={testid}>
      {events.map((e) => {
        const fail = e.type.endsWith("failed");
        return (
          <li key={e.id} className="rounded bg-white/[0.02] px-2 py-1">
            <span className="text-slate-600">#{e.seq} </span>
            <span style={{ color: fail ? "#ef4444" : TYPE_COLOR[e.type.split(".")[0]] }}>{e.type}</span>{" "}
            <span className="text-slate-500">{summarize(e)}</span>
          </li>
        );
      })}
    </ol>
  );
}

function summarize(e: PosEvent): string {
  switch (e.type) {
    case "task.created":
      return e.payload.prompt;
    case "task.planned":
      return e.payload.steps.map((s) => s.agent_id).join(" → ");
    case "agent.started":
    case "agent.completed":
    case "agent.thinking":
      return e.payload.agent_id;
    case "tool.started":
    case "tool.completed":
    case "tool.failed":
      return `${e.payload.agent_id}→${e.payload.tool_id}`;
    case "approval.requested":
      return `${e.payload.tool_id}: ${e.payload.reason}`;
    case "approval.granted":
      return `by ${e.payload.by}`;
    case "artifact.created":
      return e.payload.title;
    case "execution.completed":
      return `${e.payload.duration_ms} ms`;
    case "execution.failed":
      return e.payload.error;
  }
}

function Artifacts() {
  const artifacts = useGraph((s) => s.artifacts);
  if (artifacts.length === 0) return <p className="text-slate-600">No artifacts yet.</p>;
  return (
    <ul className="space-y-2" data-testid="artifacts">
      {[...artifacts].reverse().map((a) => (
        <li key={a.artifact_id} className="rounded border border-emerald-500/20 bg-emerald-500/5 p-2">
          <div className="mb-1 flex justify-between">
            <span className="font-semibold text-emerald-200">{a.title}</span>
            <span className="text-slate-500">{a.mime}</span>
          </div>
          <pre className="whitespace-pre-wrap text-[11px] text-slate-300">{a.content}</pre>
        </li>
      ))}
    </ul>
  );
}
