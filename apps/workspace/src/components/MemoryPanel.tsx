import { useCallback, useEffect, useState } from "react";
import { deleteMemory, listMemory, type MemoryItem } from "../lib/api";
import { PROJECT_ID, useGraph } from "../store/graph";

const LAYER_STYLE: Record<MemoryItem["layer"], string> = {
  personal: "bg-pink-500/15 text-pink-200",
  project: "bg-violet-500/15 text-violet-200",
  execution: "bg-slate-500/20 text-slate-300",
};

/** G3.9: list, search and delete the memories visible in the current project (own + personal). */
export function MemoryPanel() {
  const projectId = useGraph((s) => s.projectId);
  const setProjectId = useGraph((s) => s.setProjectId);
  // refetch whenever a memory tool finishes (every write is an event)
  const memoryEvents = useGraph(
    (s) => s.log.filter((e) => e.type === "tool.completed" && e.payload.tool_id.startsWith("memory_")).length,
  );
  const [project, setProject] = useState(projectId);
  const [q, setQ] = useState("");
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await listMemory(projectId, q.trim() || undefined));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [projectId, q]);

  useEffect(() => {
    void load();
  }, [load, memoryEvents]);

  const applyProject = () => {
    const p = project.trim().toLowerCase();
    if (PROJECT_ID.test(p)) setProjectId(p);
    else setProject(projectId);
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-3 text-xs" data-testid="memory-panel">
      <label className="mb-2 flex items-center gap-2">
        <span className="shrink-0 text-slate-400">Project</span>
        <input
          data-testid="project-input"
          value={project}
          onChange={(e) => setProject(e.target.value)}
          onBlur={applyProject}
          onKeyDown={(e) => e.key === "Enter" && applyProject()}
          className="min-w-0 flex-1 rounded border border-white/10 bg-black/30 px-2 py-1 text-slate-100"
          aria-label="current project"
        />
      </label>
      <input
        data-testid="memory-search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search memories…"
        className="mb-3 w-full rounded border border-white/10 bg-black/30 px-2 py-1 text-slate-100 placeholder:text-slate-600"
        aria-label="search memories"
      />
      {error && <p className="mb-2 break-words text-red-400">{error}</p>}
      {items.length === 0 && (
        <p className="text-slate-500" data-testid="memory-empty">
          Nothing remembered in <b>{projectId}</b> yet. Say &ldquo;Remember that &hellip;&rdquo; in Chat.
        </p>
      )}
      <ul className="space-y-1.5" data-testid="memory-list">
        {items.map((m) => (
          <li key={m.id} data-testid="memory-item" data-layer={m.layer} className="flex items-start gap-2 rounded bg-white/[0.03] p-2">
            <span className={`shrink-0 rounded px-1.5 py-px text-[10px] uppercase tracking-wider ${LAYER_STYLE[m.layer]}`}>{m.layer}</span>
            <span className="min-w-0 flex-1 break-words text-slate-200">{m.text}</span>
            <button
              data-testid="memory-delete"
              aria-label={`delete memory: ${m.text}`}
              onClick={async () => {
                await deleteMemory(m.id, projectId).catch((e) => setError(String(e)));
                void load();
              }}
              className="shrink-0 rounded px-1.5 text-slate-500 hover:bg-red-500/15 hover:text-red-300"
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
