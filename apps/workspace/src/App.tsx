import { useEffect } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { Canvas } from "./components/Canvas";
import { FpsMeter } from "./components/FpsMeter";
import { Inspector } from "./components/Inspector";
import { NodePopup } from "./components/NodePopup";
import { TaskBar } from "./components/TaskBar";
import { fetchAgents } from "./lib/api";
import { startStress, stressCount } from "./lib/stress";
import { connectEvents } from "./lib/ws";
import { useGraph } from "./store/graph";

export default function App() {
  const agentsError = useGraph((s) => s.agentsError);
  const loaded = useGraph((s) => Object.keys(s.agents).length > 0);

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
    <ReactFlowProvider>
      <main className="relative h-full w-full overflow-hidden pr-[340px]">
        <div className="relative h-full w-full">
          {loaded && <Canvas />}
          {!loaded && (
            <div className="flex h-full items-center justify-center text-sm text-slate-500">
              {agentsError ? `Failed to load agents: ${agentsError}` : "Loading agents…"}
            </div>
          )}
          <FpsMeter />
          <div className="pointer-events-none absolute right-4 top-3 z-20 text-[11px] font-semibold uppercase tracking-[0.25em] text-slate-600">
            Personal AI OS
          </div>
          <TaskBar />
        </div>
        <Inspector />
        <NodePopup />
      </main>
    </ReactFlowProvider>
  );
}
