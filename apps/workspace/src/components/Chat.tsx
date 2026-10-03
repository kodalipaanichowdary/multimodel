import { Fragment, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { decideApproval, submitTask } from "../lib/api";
import { useGraph } from "../store/graph";
import type { ChatItem, ChatTone } from "../store/projection";
import { STATE_COLOR } from "../lib/theme";
import { Markdown } from "./Markdown";
import { LiveStrip } from "./LiveStrip";

const TONE: Record<ChatTone, string> = {
  info: "#94a3b8",
  running: "#22d3ee",
  done: "#10b981",
  warn: "#f59e0b",
  error: "#ef4444",
};

export function ChatView() {
  const chat = useGraph((s) => s.chat);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Follow new messages unless the user scrolled up to read history.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [chat]);

  return (
    <div
      ref={scroller}
      data-testid="chat-log"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      className="min-h-0 flex-1 space-y-2 overflow-y-auto overflow-x-hidden p-3"
    >
      {chat.length === 0 && (
        <div className="mt-6 text-center text-xs text-slate-500">
          <p className="mb-1 text-sm text-slate-300">Give the OS a task.</p>
          <p>Agents light up on the canvas; the result lands here.</p>
          <p className="mt-1 text-slate-600">Include the word “fail” to see the failure path.</p>
        </div>
      )}
      {chat.map((m, i) => (
        <Fragment key={m.id}>
          <Message m={m} />
          {/* each run's strip/chip closes its group */}
          {chat[i + 1]?.task_id !== m.task_id && <LiveStrip taskId={m.task_id} />}
        </Fragment>
      ))}
    </div>
  );
}

function Message({ m }: { m: ChatItem }) {
  const openArtifact = useGraph((s) => s.openArtifact);
  const agentName = useGraph((s) => (m.kind === "error" && m.agent_id ? s.agents[m.agent_id]?.name ?? m.agent_id : null));
  switch (m.kind) {
    case "user":
      return (
        <div className="flex justify-end pt-2" data-testid="chat-user">
          <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-violet-500/25 px-3 py-2 text-sm text-slate-100">
            {m.text}
          </p>
        </div>
      );
    case "status":
      return (
        <div className="flex items-start gap-2 pl-1 text-xs text-slate-400" data-testid="chat-status" data-tone={m.tone}>
          <span
            className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${m.tone === "running" ? "animate-pulse" : ""}`}
            style={{ background: TONE[m.tone] }}
          />
          <span className="min-w-0 break-words">{m.text}</span>
        </div>
      );
    case "result":
      return (
        <div className="rounded-lg border border-emerald-500/25 bg-[#0f1417] p-3" data-testid="chat-result">
          <div className="mb-2 flex items-center gap-2 border-b border-white/5 pb-2 text-xs" data-testid="artifact-card">
            <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
            <span className="min-w-0 truncate font-semibold text-emerald-200" data-testid="artifact-title">
              {m.artifact.title}
            </span>
            <span className="shrink-0 text-slate-500" data-testid="artifact-mime">
              {m.artifact.mime}
            </span>
            <button
              data-testid="open-artifact"
              onClick={() => openArtifact(m.artifact.artifact_id)}
              className="ml-auto shrink-0 rounded border border-white/10 px-2 py-0.5 text-slate-300 hover:bg-white/5"
            >
              Open in inspector
            </button>
          </div>
          {m.artifact.mime === "text/markdown" ? (
            <Markdown source={m.artifact.content} testid="chat-markdown" />
          ) : (
            <pre className="whitespace-pre-wrap break-words text-xs text-slate-300">{m.artifact.content}</pre>
          )}
        </div>
      );
    case "approval":
      return <ApprovalCard m={m} />;
    case "error":
      return (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200" data-testid="chat-error">
          <p className="font-semibold text-red-300">Run failed</p>
          <p className="mt-1 text-xs">
            agent <b data-testid="chat-error-agent">{agentName ?? "unknown"}</b>
            {m.tool_id && (
              <>
                {" "}
                · tool <b data-testid="chat-error-tool">{m.tool_id}</b>
              </>
            )}
          </p>
          <p className="mt-1 break-words font-mono text-xs text-red-200/80">{m.error}</p>
        </div>
      );
  }
}

const APPROVAL_LOOK = {
  pending: { border: "border-amber-400/50 bg-amber-500/10", label: "Approval needed", color: "text-amber-200" },
  granted: { border: "border-emerald-500/30 bg-emerald-500/5", label: "Allowed", color: "text-emerald-300" },
  denied: { border: "border-red-500/40 bg-red-500/10", label: "Denied", color: "text-red-300" },
  cancelled: { border: "border-white/10 bg-white/[0.02]", label: "Cancelled (run ended)", color: "text-slate-400" },
} as const;

/** fs.write / terminal.exec gate. The run is blocked on the server until one of these is clicked. */
function ApprovalCard({ m }: { m: Extract<ChatItem, { kind: "approval" }> }) {
  const agentName = useGraph((s) => s.agents[m.agent_id]?.name ?? m.agent_id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const look = APPROVAL_LOOK[m.status];
  async function decide(decision: "allow" | "deny") {
    setBusy(true);
    setError(null);
    try {
      await decideApproval(m.approval_id, decision);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }
  return (
    <div className={`rounded-lg border p-3 text-sm ${look.border}`} data-testid="approval-card" data-status={m.status} data-approval={m.approval_id}>
      <p className={`font-semibold ${look.color}`}>
        ⚠ {look.label}
        {m.by && m.status !== "pending" && <span className="font-normal text-slate-400"> · by {m.by}</span>}
      </p>
      <p className="mt-1 break-words text-xs text-slate-300">
        <b>{agentName}</b> wants to run <code className="rounded bg-white/10 px-1">{m.tool_id}</code>: {m.reason}
      </p>
      {m.status === "pending" && (
        <div className="mt-2 flex gap-2">
          <button
            data-testid="approval-allow"
            disabled={busy}
            onClick={() => decide("allow")}
            className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
          >
            Allow once
          </button>
          <button
            data-testid="approval-deny"
            disabled={busy}
            onClick={() => decide("deny")}
            className="rounded-md border border-red-400/50 px-3 py-1 text-xs font-medium text-red-200 hover:bg-red-500/15 disabled:opacity-40"
          >
            Deny
          </button>
        </div>
      )}
      {error && <p className="mt-1 break-words text-xs text-red-400">{error}</p>}
    </div>
  );
}

export function Composer() {
  // G3.1: the draft lives in the store, so it survives the dock/drawer/sheet remount
  const prompt = useGraph((s) => s.draft);
  const setPrompt = useGraph((s) => s.setDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsStatus = useGraph((s) => s.wsStatus);
  const selected = useGraph((s) => s.nextSelected);
  const agents = useGraph((s) => s.agents);
  const toggle = useGraph((s) => s.toggleSelected);
  const taskState = useGraph((s) => (s.activeTaskId ? s.nodes[`task:${s.activeTaskId}`]?.state : undefined));
  const running = taskState === "running";

  // Drop selections for agents that no longer exist.
  useEffect(() => {
    for (const id of selected) if (!agents[id]) toggle(id);
  }, [agents, selected, toggle]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const p = prompt.trim();
    if (!p || busy) return;
    setBusy(true);
    setError(null);
    try {
      await submitTask(p, selected, useGraph.getState().projectId);
      setPrompt("");
      useGraph.getState().clearSelected();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="shrink-0 border-t border-white/5 p-2" data-testid="composer">
      {selected.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1 px-1">
          {selected.map((id) => (
            <button
              key={id}
              type="button"
              data-testid={`selected-chip-${id}`}
              onClick={() => toggle(id)}
              className="rounded-full bg-violet-500/15 px-2 py-0.5 text-[11px] text-violet-200 hover:bg-violet-500/25"
              title="remove from next task"
            >
              + {agents[id]?.name ?? id} ×
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-[#0d0f16] p-1.5 pl-3">
        <input
          data-testid="task-input"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Give the OS a task…"
          maxLength={4000}
          className="min-w-0 flex-1 bg-transparent text-sm text-slate-100 placeholder:text-slate-600"
        />
        {taskState && (
          <span
            className="shrink-0 text-[10px] uppercase tracking-wider"
            style={{ color: STATE_COLOR[taskState] }}
            data-testid="task-state"
          >
            {taskState}
          </span>
        )}
        <button
          type="submit"
          data-testid="task-submit"
          disabled={!prompt.trim() || busy || running || wsStatus !== "open"}
          className="shrink-0 rounded-lg bg-violet-500 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-violet-400 disabled:cursor-not-allowed disabled:opacity-30"
        >
          {running ? "Running…" : "Run"}
        </button>
      </div>
      {error && <p className="mt-1 break-words px-2 text-xs text-red-400">{error}</p>}
    </form>
  );
}
