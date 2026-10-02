import { useEffect } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { MotionConfig } from "framer-motion";
import { AddAgentDialog } from "./components/AddAgentDialog";
import { Canvas } from "./components/Canvas";
import { Dock } from "./components/Dock";
import { FpsMeter } from "./components/FpsMeter";
import { NodePopup } from "./components/NodePopup";
import { fetchAgents } from "./lib/api";
import { startStress, stressCount } from "./lib/stress";
import { useLayoutMode } from "./lib/useLayoutMode";
import { connectEvents } from "./lib/ws";
import { useGraph } from "./store/graph";

export default function App() {
  const agentsError = useGraph((s) => s.agentsError);
  const loaded = useGraph((s) => Object.keys(s.agents).length > 0);
  const mode = useLayoutMode();

  useEffect(() => {
    let stopStress: (() => void) | undefined;
    const ctl = new AbortController();
    fetchAgents()
      .then((list) => {
        if (ctl.signal.aborted) return;
        useGraph.getState().setAgents(list);
        const n = stressCount();
        if (n) stopStress = startStress(n);
      })
      .catch((e) => useGraph.getState().setAgentsError(String(e)));
    const disconnect = connectEvents();
    return () => {
      ctl.abort();
      disconnect();
      stopStress?.();
    };
  }, []);

  return (
    <MotionConfig reducedMotion="user">
    <ReactFlowProvider>
      <main
        data-layout={mode}
        className={`flex h-[100dvh] w-full overflow-hidden ${mode === "sheet" ? "flex-col" : "flex-row"}`}
      >
        <section className="relative min-h-0 min-w-0 flex-1" data-testid="canvas-region">
          {loaded && <Canvas />}
          {!loaded && (
            <div className="flex h-full items-center justify-center px-4 text-center text-sm text-slate-500">
              {agentsError ? `Failed to load agents: ${agentsError}` : "Loading agents…"}
            </div>
          )}
          <FpsMeter />
          <div className="absolute right-3 top-3 z-20 flex items-center gap-3">
            <span className="pointer-events-none hidden text-[11px] font-semibold uppercase tracking-[0.25em] text-slate-600 sm:inline">
              Personal AI OS
            </span>
            <button
              data-testid="add-agent-open"
              onClick={() => useGraph.getState().setAddAgentOpen(true)}
              className="rounded-lg border border-white/10 bg-[#0d0f16]/90 px-2.5 py-1 text-xs font-medium text-slate-200 hover:border-violet-400/50 hover:text-white"
            >
              + Agent
            </button>
          </div>
        </section>
        <Dock mode={mode} />
        <NodePopup />
        <AddAgentDialog />
      </main>
    </ReactFlowProvider>
    </MotionConfig>
  );
}
