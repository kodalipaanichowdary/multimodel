import { useEffect, useMemo, useState } from "react";
import { useGraph } from "../store/graph";
import { runStatus, runTimeline, type ChipStatus } from "../store/projection";
import { STATE_COLOR } from "../lib/theme";
import { ScorecardView } from "./Scorecard";

const CHIP: Record<ChipStatus, string> = {
  running: "border-cyan-400/50 text-cyan-200 bg-cyan-400/10",
  completed: "border-emerald-500/40 text-emerald-200 bg-emerald-500/10",
  failed: "border-red-500/50 text-red-200 bg-red-500/10",
};
const CHIP_ICON: Record<ChipStatus, string> = { running: "●", completed: "✓", failed: "✗" };

const fmt = (ms: number | null) => (ms === null ? "—" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)}s`);

/** Live per-agent timeline. Everything here is derived from Run.events. */
export function RunView() {
  const runOrder = useGraph((s) => s.runOrder);
  const chosen = useGraph((s) => s.runViewTask);
  const setChosen = useGraph((s) => s.setRunViewTask);
  const taskId = chosen ?? runOrder[runOrder.length - 1] ?? null;
  const run = useGraph((s) => (taskId ? s.runs[taskId] : undefined));
  const agents = useGraph((s) => s.agents);
  const tl = useMemo(() => (run ? runTimeline(run) : null), [run]);
  const status = run ? runStatus(run) : null;

  // Elapsed ticks while running; frozen at the last event's ts once finished.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (status !== "running") return;
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [status]);

  if (!run || !tl || tl.start_ts === null) {
    return <p className="p-4 text-xs text-slate-500" data-testid="run-empty">No runs yet. Submit a task in Chat.</p>;
  }
  const end = status === "running" ? Math.max(now, tl.last_ts ?? now) : (tl.last_ts ?? tl.start_ts);
  const elapsed = Math.max(0, end - tl.start_ts);
  const toolsCalled = tl.rows.reduce((n, r) => n + r.tools.length, 0);
  const agentsUsed = tl.rows.filter((r) => r.started_ms !== null).length;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-3 text-xs" data-testid="run-view">
      <div className="mb-2 flex items-center gap-2">
        <select
          data-testid="run-select"
          value={taskId ?? ""}
          onChange={(e) => setChosen(e.target.value)}
          className="min-w-0 flex-1 truncate rounded border border-white/10 bg-[#0d0f16] px-2 py-1 text-xs text-slate-200"
        >
          {[...runOrder].reverse().map((id, i) => (
            <option key={id} value={id}>
              #{runOrder.length - i} · {useGraph.getState().runs[id]?.prompt.slice(0, 48)}
            </option>
          ))}
        </select>
        <span
          data-testid="run-status"
          className={`shrink-0 text-[10px] font-semibold uppercase tracking-wider ${status === "completed" ? "text-emerald-400" : status === "failed" ? "text-red-400" : "text-cyan-300"}`}
        >
          {status}
        </span>
      </div>

      <div className="mb-3 grid grid-cols-4 gap-1.5 text-center">
        <Counter label="agents used" value={agentsUsed} testid="run-agents" />
        <Counter label="tools called" value={toolsCalled} testid="run-tools" />
        <Counter label="events" value={run.events.length} testid="run-events" />
        <Counter label="elapsed" value={`${(elapsed / 1000).toFixed(1)}s`} testid="run-elapsed" />
      </div>

      <ol className="space-y-1.5" data-testid="timeline">
        {tl.rows.map((r) => (
          <li
            key={r.agent_id}
            data-testid={`tl-row-${r.agent_id}`}
            data-state={r.state}
            className="rounded-md border border-white/5 bg-white/[0.02] px-2.5 py-2"
          >
            <div className="flex items-center gap-2">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${r.state === "running" || r.state === "thinking" ? "animate-pulse" : ""}`}
                style={{ background: STATE_COLOR[r.state] }}
              />
              <span className="min-w-0 flex-1 truncate font-medium text-slate-200">
                {agents[r.agent_id]?.name ?? r.agent_id}
              </span>
              <span className="shrink-0 text-[10px] uppercase tracking-wider" style={{ color: STATE_COLOR[r.state] }}>
                {r.state.replace("_", " ")}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 pl-4 text-[11px] text-slate-500">
              <span>
                start <b className="font-mono font-normal text-slate-300">{r.started_ms === null ? "—" : `+${fmt(r.started_ms)}`}</b>
              </span>
              <span>
                took <b className="font-mono font-normal text-slate-300" data-testid={`tl-dur-${r.agent_id}`}>{fmt(r.duration_ms)}</b>
              </span>
              {r.tools.map((c) => (
                <span
                  key={c.call_id}
                  data-testid={`tl-chip-${c.tool_id}`}
                  data-status={c.status}
                  className={`rounded-full border px-1.5 py-px font-mono text-[10px] ${CHIP[c.status]}`}
                >
                  {CHIP_ICON[c.status]} {c.tool_id}
                  {c.duration_ms !== null && <span className="opacity-70"> {c.duration_ms}ms</span>}
                </span>
              ))}
            </div>
          </li>
        ))}
      </ol>

      {status !== "running" && (
        <div className="mt-3">
          <ScorecardView taskId={run.task_id} />
        </div>
      )}
    </div>
  );
}

function Counter({ label, value, testid }: { label: string; value: number | string; testid: string }) {
  return (
    <div className="rounded bg-white/[0.03] px-1 py-1.5">
      <div className="font-mono text-sm text-slate-100" data-testid={testid}>
        {value}
      </div>
      <div className="text-[10px] text-slate-500">{label}</div>
    </div>
  );
}
