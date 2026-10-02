import { useEffect, useMemo, useState } from "react";
import { useGraph } from "../store/graph";
import { liveStats, runTimeline, stripModel, stripSummary } from "../store/projection";
import { STATE_COLOR } from "../lib/theme";
import { ScorecardView } from "./Scorecard";

/** Re-render every `ms` while `on`; returns the browser clock. */
function useNow(on: boolean, ms = 200): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [on, ms]);
  return now;
}

const pct = (i: number, n: number) => (n <= 1 ? 50 : (i / (n - 1)) * 100);

/**
 * One per run, at the end of the run's chat group. Live: agent dots on a line with a
 * travelling pulse + counters. Finished: one-line chip; click toggles the scorecard.
 * Both states share a fixed-height slot so collapsing never shifts the chat.
 */
export function LiveStrip({ taskId }: { taskId: string }) {
  const run = useGraph((s) => s.runs[taskId]);
  const offset = useGraph((s) => s.clockOffsets[taskId] ?? 0);
  const agents = useGraph((s) => s.agents);
  const model = useMemo(() => (run ? stripModel(run) : null), [run]);
  const timeline = useMemo(() => (run ? runTimeline(run) : null), [run]);
  const done = useMemo(() => (run ? liveStats(run, 0, 0).done : false), [run]);
  const now = useNow(!!run && !done);
  const [open, setOpen] = useState(false);
  if (!run || !model || !timeline) return null;

  const stats = liveStats(run, now, offset);
  const summary = done ? stripSummary(run) : null;
  const n = model.dots.length;
  const active = model.activeIndex >= 0 ? model.dots[model.activeIndex] : null;
  const name = (id: string) => agents[id]?.name ?? id;

  let status = "Planning…";
  let statusColor = "#94a3b8";
  if (active) {
    statusColor = STATE_COLOR[active.state];
    const row = timeline.rows.find((r) => r.agent_id === active.agent_id);
    const tool = row?.tools.find((c) => c.status === "running");
    status =
      active.state === "waiting_approval"
        ? `${name(active.agent_id)} · awaiting approval`
        : active.state === "error"
          ? `${name(active.agent_id)} · failed`
          : tool
            ? `${name(active.agent_id)} · ${tool.tool_id} running`
            : `${name(active.agent_id)} · ${active.state}`;
  } else if (n > 0) {
    status = "Orchestrating…";
  }

  return (
    <div className="pt-1" data-testid="run-strip-wrap" data-task={taskId}>
      <div
        className="relative h-12 overflow-hidden rounded-lg"
        data-testid="run-strip"
        data-task={taskId}
        data-phase={done ? "done" : "live"}
      >
        {/* live layer */}
        <div
          aria-hidden={done}
          className={`strip-anim absolute inset-0 flex flex-col justify-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 transition-[opacity,transform] duration-300 ${
            done ? "pointer-events-none -translate-y-1 opacity-0" : "opacity-100"
          }`}
        >
          <div className="relative mx-1.5 h-2.5" data-testid="strip-track">
            <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-white/15" />
            <span
              data-testid="strip-fill"
              className="strip-anim absolute inset-x-0 top-1/2 h-px origin-left -translate-y-1/2 bg-emerald-400/80 transition-transform duration-300"
              style={{ transform: `translateY(-50%) scaleX(${model.progress})` }}
            />
            {active && (
              <span
                data-testid="strip-pulse-track"
                className="strip-anim pointer-events-none absolute inset-0 transition-transform duration-500 ease-out"
                style={{ transform: `translateX(${pct(model.activeIndex, n)}%)` }}
              >
                <span
                  data-testid="strip-pulse"
                  data-state={active.state}
                  className={`absolute left-0 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 ${
                    active.state === "error" ? "" : "strip-pulse"
                  }`}
                  style={{ borderColor: STATE_COLOR[active.state] }}
                />
              </span>
            )}
            {model.dots.map((d, i) => (
              <span
                key={d.agent_id}
                data-testid={`strip-dot-${d.agent_id}`}
                data-state={d.state}
                title={`${name(d.agent_id)}: ${d.state.replace("_", " ")}`}
                className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
                style={{
                  left: `${pct(i, n)}%`,
                  background: d.state === "queued" ? "#0a0b10" : STATE_COLOR[d.state],
                  boxShadow: `0 0 0 1.5px ${STATE_COLOR[d.state]}`,
                }}
              />
            ))}
          </div>
          <div className="flex items-center gap-3 text-[11px] tabular-nums text-slate-400">
            <span
              aria-live="polite"
              data-testid="strip-status"
              className="min-w-0 flex-1 truncate font-medium"
              style={{ color: statusColor }}
            >
              {status}
            </span>
            <span className="shrink-0" title="tools running / done / failed">
              <span className="text-cyan-300" data-testid="strip-tools-running">{stats.tools_running}</span>
              <span className="text-slate-600"> run · </span>
              <span className="text-emerald-300" data-testid="strip-tools-done">{stats.tools_done}</span>
              <span className="text-slate-600"> ok · </span>
              <span className={stats.tools_failed ? "text-red-300" : ""} data-testid="strip-tools-failed">
                {stats.tools_failed}
              </span>
              <span className="text-slate-600"> ✗</span>
            </span>
            <span className="shrink-0" data-testid="strip-evps">
              {stats.events_per_sec.toFixed(1)} ev/s
            </span>
            <span className="w-11 shrink-0 text-right text-slate-200" data-testid="strip-elapsed">
              {(stats.elapsed_ms / 1000).toFixed(1)}s
            </span>
          </div>
        </div>

        {/* finished layer: one-line chip */}
        <div
          aria-hidden={!done}
          className={`strip-anim absolute inset-0 flex items-center transition-[opacity,transform] duration-300 ${
            done ? "opacity-100" : "pointer-events-none translate-y-1 opacity-0"
          }`}
        >
          {summary && (
            <button
              data-testid="run-chip"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
              className={`flex max-w-full items-center gap-2 rounded-full border px-3 py-1 text-xs tabular-nums ${
                summary.ok
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-100 hover:bg-emerald-500/15"
                  : "border-red-500/40 bg-red-500/10 text-red-100 hover:bg-red-500/15"
              }`}
            >
              <span className="truncate" data-testid="run-chip-text">
                {summary.text}
              </span>
              <span className={`strip-anim shrink-0 transition-transform ${open ? "rotate-90" : ""}`}>▸</span>
            </button>
          )}
        </div>
      </div>
      {done && open && (
        <div className="mt-1.5">
          <ScorecardView taskId={taskId} />
        </div>
      )}
    </div>
  );
}
