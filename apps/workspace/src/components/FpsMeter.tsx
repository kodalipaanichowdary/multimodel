import { useEffect, useRef } from "react";
import { useGraph } from "../store/graph";

declare global {
  interface Window {
    /** Rolling 1-second FPS samples; read by e2e perf test. */
    __fpsSamples?: number[];
  }
}

export function FpsMeter() {
  const el = useRef<HTMLSpanElement>(null);
  const nodeCount = useGraph((s) => Object.keys(s.nodes).length);

  useEffect(() => {
    let frames = 0;
    let last = performance.now();
    let raf = 0;
    window.__fpsSamples = [];
    const tick = (now: number) => {
      frames++;
      if (now - last >= 1000) {
        const fps = Math.round((frames * 1000) / (now - last));
        window.__fpsSamples!.push(fps);
        if (window.__fpsSamples!.length > 120) window.__fpsSamples!.shift();
        if (el.current) {
          el.current.textContent = `${fps} fps`;
          el.current.style.color = fps >= 50 ? "#10b981" : fps >= 30 ? "#f59e0b" : "#ef4444";
        }
        frames = 0;
        last = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="pointer-events-none absolute left-3 top-3 z-30 flex gap-3 rounded-md bg-black/40 px-2 py-1 font-mono text-[11px] text-slate-500">
      <span ref={el} data-testid="fps">
        – fps
      </span>
      <span data-testid="node-count">{nodeCount} nodes</span>
    </div>
  );
}
