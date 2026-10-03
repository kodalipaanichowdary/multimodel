import { useEffect, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useGraph } from "../store/graph";
import { baseAgentId } from "../store/projection";
import { killTask } from "../lib/api";
import { DANGEROUS, KIND_COLOR, STATE_COLOR } from "../lib/theme";

const W = 300;
const popupWidth = () => Math.min(W, window.innerWidth - 16);

export function NodePopup() {
  const popup = useGraph((s) => s.popup);
  const node = useGraph((s) => (s.popup ? s.nodes[s.popup.nodeId] : undefined));
  const agent = useGraph((s) => (node?.kind === "agent" ? s.agents[baseAgentId(node.ref_id)] : undefined));
  const detail = useGraph((s) => (node ? s.detail[node.id] : undefined));
  const close = useGraph((s) => s.closePopup);
  const picked = useGraph((s) => (node ? s.nextSelected.includes(node.ref_id) : false));
  const toggle = useGraph((s) => s.toggleSelected);
  const activeTask = useGraph((s) =>
    s.activeTaskId && s.nodes[`task:${s.activeTaskId}`]?.state === "running" ? s.activeTaskId : null,
  );
  const working = node ? ["running", "thinking", "waiting_approval"].includes(node.state) : false;

  useEffect(() => {
    // G3.4: Esc closes and gives focus back to the node the popup belongs to
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const id = useGraph.getState().popup?.nodeId;
      close();
      // after this event: React Flow's own Escape handling blurs the focused node first
      if (id) setTimeout(() => document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`)?.focus(), 0);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  // Open toward the roomier vertical half so the popup never runs off-screen.
  const w = popupWidth();
  const x = popup ? Math.max(8, Math.min(popup.x + 16, window.innerWidth - w - 8)) : 0;
  const below = popup ? popup.y < window.innerHeight / 2 : true;
  const anchor = popup
    ? below
      ? { top: Math.max(8, popup.y - 20) }
      : { bottom: Math.max(8, window.innerHeight - popup.y - 20) }
    : {};

  return (
    <AnimatePresence>
      {popup && node && (
        <motion.div
          key={node.id}
          data-testid="node-popup"
          initial={{ opacity: 0, scale: 0.92, y: 6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.14 }}
          className="fixed z-50 rounded-xl border border-white/10 bg-[#0d0f16]/95 p-4 text-sm shadow-2xl backdrop-blur"
          style={{ left: x, width: w, maxHeight: "calc(100vh - 16px)", overflowY: "auto", ...anchor }}
        >
          <div className="mb-2 flex items-center gap-2">
            <span className="h-3 w-3 rounded-full" style={{ background: KIND_COLOR[node.kind] }} />
            <span className="font-semibold text-slate-50">{node.label}</span>
            <span className="text-[10px] uppercase tracking-wider text-slate-500">{node.kind}</span>
            <span
              className="ml-auto rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider"
              style={{ color: STATE_COLOR[node.state], background: STATE_COLOR[node.state] + "22" }}
            >
              {node.state.replace("_", " ")}
            </span>
            <button
              aria-label="close"
              onClick={close}
              className="ml-1 text-slate-500 hover:text-slate-200"
            >
              ×
            </button>
          </div>

          {agent ? (
            <>
              <p className="mb-3 break-words text-slate-400">{agent.description}</p>
              {working && activeTask && (
                <button
                  data-testid="popup-kill"
                  onClick={() => killTask(activeTask).catch((e) => console.warn("[kill]", e))}
                  className="mb-2 w-full rounded-md border border-red-400/50 px-2 py-1 text-xs text-red-200 hover:bg-red-500/15"
                >
                  ■ Stop {agent.name} (kills this run)
                </button>
              )}
              {agent.id !== "orchestrator" && (
                <button
                  data-testid="popup-select"
                  aria-pressed={picked}
                  onClick={() => toggle(agent.id)}
                  className={`mb-3 w-full rounded-md border px-2 py-1 text-xs ${
                    picked
                      ? "border-violet-400/60 bg-violet-500/20 text-violet-100"
                      : "border-white/10 text-slate-300 hover:bg-white/5"
                  }`}
                >
                  {picked ? "✓ Included in next task" : "+ Include in next task"}
                </button>
              )}
              <Section title="Capabilities">
                <Chips items={agent.capabilities} testid="popup-capabilities" />
              </Section>
              <Section title="Tools">
                <Chips items={agent.tools} empty="none" />
              </Section>
              <Section title="Permissions">
                <div className="flex flex-wrap gap-1">
                  {agent.permissions.length === 0 && <span className="text-xs text-slate-600">none</span>}
                  {agent.permissions.map((p) => (
                    <span
                      key={p}
                      className={`rounded px-1.5 py-0.5 text-[11px] ${
                        DANGEROUS.has(p) ? "bg-red-500/15 text-red-300" : "bg-white/5 text-slate-300"
                      }`}
                      title={DANGEROUS.has(p) ? "requires approval" : undefined}
                    >
                      {p}
                      {DANGEROUS.has(p) && " ⚠"}
                    </span>
                  ))}
                </div>
              </Section>
              <div className="mt-3 grid grid-cols-2 gap-x-3 text-[11px] text-slate-500">
                <span>
                  model <b className="font-medium text-slate-300">{agent.model_profile.model}</b>
                </span>
                <span>
                  T=<b className="font-medium text-slate-300">{agent.model_profile.temperature}</b>
                </span>
                <span>
                  memory{" "}
                  <b className="font-medium text-slate-300">
                    {agent.memory.scope}/{agent.memory.kind}
                  </b>
                </span>
              </div>
            </>
          ) : (
            <p className="text-slate-400">id: {node.ref_id}</p>
          )}
          {detail && (
            <p className="mt-3 border-t border-white/5 pt-2 font-mono text-[11px] text-slate-400">
              {detail}
            </p>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-2">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">{title}</div>
      {children}
    </div>
  );
}

function Chips({ items, empty, testid }: { items: string[]; empty?: string; testid?: string }) {
  return (
    <div className="flex flex-wrap gap-1" data-testid={testid}>
      {items.length === 0 && <span className="text-xs text-slate-600">{empty}</span>}
      {items.map((i) => (
        <span key={i} className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[11px] text-violet-200">
          {i}
        </span>
      ))}
    </div>
  );
}
