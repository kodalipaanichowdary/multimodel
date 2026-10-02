import { useEffect, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useGraph } from "../store/graph";
import { DANGEROUS, KIND_COLOR, STATE_COLOR } from "../lib/theme";

const W = 300;

export function NodePopup() {
  const popup = useGraph((s) => s.popup);
  const node = useGraph((s) => (s.popup ? s.nodes[s.popup.nodeId] : undefined));
  const agent = useGraph((s) => (node?.kind === "agent" ? s.agents[node.ref_id] : undefined));
  const detail = useGraph((s) => (node ? s.detail[node.id] : undefined));
  const close = useGraph((s) => s.closePopup);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  // Open toward the roomier vertical half so the popup never runs off-screen.
  const x = popup ? Math.max(8, Math.min(popup.x + 16, window.innerWidth - W - 348)) : 0;
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
          style={{ left: x, width: W, maxHeight: "calc(100vh - 16px)", overflowY: "auto", ...anchor }}
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
              <p className="mb-3 text-slate-400">{agent.description}</p>
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
