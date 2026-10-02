import { useMemo } from "react";
import { useGraph } from "../store/graph";
import { scorecard, type Scorecard } from "../store/projection";

const FIELDS: { key: keyof Scorecard; label: string }[] = [
  { key: "agents_used", label: "agents" },
  { key: "tools_called", label: "tools" },
  { key: "tools_failed", label: "tool fails" },
  { key: "approvals", label: "approvals" },
  { key: "events_total", label: "events" },
  { key: "events_invalid_dropped", label: "invalid dropped" },
  { key: "duration_ms", label: "duration ms" },
];

export function ScorecardView({ taskId }: { taskId: string }) {
  const run = useGraph((s) => s.runs[taskId]);
  const sc = useMemo(() => (run ? scorecard(run) : null), [run]);
  if (!sc) return null;
  const ok = sc.status === "completed";
  return (
    <div
      data-testid="scorecard"
      data-task={taskId}
      className={`rounded-lg border p-2.5 text-xs ${ok ? "border-emerald-500/25 bg-emerald-500/5" : sc.status === "failed" ? "border-red-500/30 bg-red-500/5" : "border-white/10"}`}
    >
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-slate-500">Run scorecard</span>
        <span
          data-testid="sc-status"
          className={`text-[10px] font-semibold uppercase tracking-wider ${ok ? "text-emerald-400" : sc.status === "failed" ? "text-red-400" : "text-sky-300"}`}
        >
          {sc.status}
        </span>
      </div>
      <dl className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-1.5">
        {FIELDS.map((f) => (
          <div key={f.key} className="rounded bg-white/[0.03] px-2 py-1">
            <dd data-testid={`sc-${f.key}`} className="font-mono text-sm text-slate-100">
              {sc[f.key]}
            </dd>
            <dt className="text-[10px] text-slate-500">{f.label}</dt>
          </div>
        ))}
      </dl>
    </div>
  );
}
