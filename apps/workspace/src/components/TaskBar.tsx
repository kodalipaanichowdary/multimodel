import { useState, type FormEvent } from "react";
import { submitTask } from "../lib/api";
import { useGraph } from "../store/graph";
import { STATE_COLOR } from "../lib/theme";

const WS_COLOR = { open: "#10b981", connecting: "#f59e0b", closed: "#ef4444" } as const;

export function TaskBar() {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsStatus = useGraph((s) => s.wsStatus);
  const taskState = useGraph((s) => (s.activeTaskId ? s.nodes[`task:${s.activeTaskId}`]?.state : undefined));
  const running = taskState === "running";

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const p = prompt.trim();
    if (!p || busy) return;
    setBusy(true);
    setError(null);
    try {
      await submitTask(p);
      setPrompt("");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="absolute bottom-5 left-1/2 z-30 w-[min(680px,calc(100vw-400px))] -translate-x-1/2"
    >
      <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-[#0d0f16]/95 p-2 pl-4 shadow-2xl backdrop-blur">
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          title={`ws ${wsStatus}`}
          data-testid="ws-status"
          data-status={wsStatus}
          style={{ background: WS_COLOR[wsStatus] }}
        />
        <input
          data-testid="task-input"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder='Give the OS a task…  (include "fail" to see the failure path)'
          maxLength={4000}
          className="min-w-0 flex-1 bg-transparent text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none"
        />
        {taskState && (
          <span className="text-[10px] uppercase tracking-wider" style={{ color: STATE_COLOR[taskState] }} data-testid="task-state">
            {taskState}
          </span>
        )}
        <button
          type="submit"
          data-testid="task-submit"
          disabled={!prompt.trim() || busy || running || wsStatus !== "open"}
          className="rounded-xl bg-violet-500 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-violet-400 disabled:cursor-not-allowed disabled:opacity-30"
        >
          {running ? "Running…" : "Run"}
        </button>
      </div>
      {error && <p className="mt-1 px-2 text-xs text-red-400">{error}</p>}
    </form>
  );
}
