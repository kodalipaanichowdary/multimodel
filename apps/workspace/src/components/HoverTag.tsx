import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { useGraph } from "../store/graph";
import { KIND_COLOR, STATE_COLOR } from "../lib/theme";

export interface HoverTagHandle {
  show: (nodeId: string, e: { clientX: number; clientY: number }) => void;
  move: (x: number, y: number) => void;
  hide: () => void;
}

/** Name tag that follows the cursor. Position via direct DOM writes (no re-render per move). */
export const HoverTag = forwardRef<HoverTagHandle>(function HoverTag(_props, ref) {
  const el = useRef<HTMLDivElement>(null);
  const [nodeId, setNodeId] = useState<string | null>(null);
  const node = useGraph((s) => (nodeId && s.popup?.nodeId !== nodeId ? s.nodes[nodeId] : undefined));

  const place = (x: number, y: number) => {
    if (el.current) el.current.style.transform = `translate(${x + 14}px, ${y + 14}px)`;
  };

  useImperativeHandle(ref, () => ({
    show: (id, e) => {
      setNodeId(id);
      place(e.clientX, e.clientY);
    },
    move: place,
    hide: () => setNodeId(null),
  }));

  return (
    <div
      ref={el}
      data-testid="hover-tag"
      className="pointer-events-none fixed left-0 top-0 z-50 will-change-transform"
      style={{ visibility: node ? "visible" : "hidden" }}
    >
      {node && (
        <div className="flex items-center gap-2 rounded-md border border-white/10 bg-[#0d0f16]/95 px-2.5 py-1 text-xs shadow-xl backdrop-blur">
          <span className="h-2 w-2 rounded-full" style={{ background: KIND_COLOR[node.kind] }} />
          <span className="font-semibold text-slate-100">{node.label}</span>
          <span className="text-[10px] uppercase tracking-wider" style={{ color: STATE_COLOR[node.state] }}>
            {node.state.replace("_", " ")}
          </span>
        </div>
      )}
    </div>
  );
});
