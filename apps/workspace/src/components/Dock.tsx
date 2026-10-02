import { useCallback, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { useGraph, type DockTab } from "../store/graph";
import type { LayoutMode } from "../lib/useLayoutMode";
import { ChatView, Composer } from "./Chat";
import { Inspector } from "./Inspector";
import { RunView } from "./RunView";

const WS_COLOR = { open: "#10b981", connecting: "#f59e0b", closed: "#ef4444" } as const;
const TABS: { id: DockTab; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "run", label: "Run" },
  { id: "inspect", label: "Inspect" },
];

/** Tabs + panels + composer. Panels stay mounted (hidden) so scroll and live state survive tab switches. */
function DockPanel({ onCollapse, collapseLabel }: { onCollapse?: () => void; collapseLabel?: string }) {
  const tab = useGraph((s) => s.dockTab);
  const setTab = useGraph((s) => s.setDockTab);
  const wsStatus = useGraph((s) => s.wsStatus);
  const schemaErrors = useGraph((s) => s.schemaErrors.length);
  const running = useGraph((s) => (s.activeTaskId ? s.nodes[`task:${s.activeTaskId}`]?.state === "running" : false));

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col" data-testid="dock-panel">
      <header className="flex shrink-0 items-center gap-1 border-b border-white/5 px-2 py-1.5 text-xs">
        <span
          className="mx-1 h-2 w-2 shrink-0 rounded-full"
          title={`ws ${wsStatus}`}
          data-testid="ws-status"
          data-status={wsStatus}
          style={{ background: WS_COLOR[wsStatus] }}
        />
        {TABS.map((t) => (
          <button
            key={t.id}
            data-testid={`dock-tab-${t.id}`}
            aria-pressed={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`rounded px-2.5 py-1 ${tab === t.id ? "bg-white/10 text-slate-100" : "text-slate-400 hover:text-slate-200"}`}
          >
            {t.label}
            {t.id === "run" && running && <span className="ml-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-400" />}
          </button>
        ))}
        {schemaErrors > 0 && (
          <span className="ml-1 shrink-0 rounded bg-red-500/15 px-1.5 text-[10px] text-red-300" data-testid="schema-errors">
            {schemaErrors} invalid
          </span>
        )}
        {onCollapse && (
          <button
            data-testid="dock-collapse"
            onClick={onCollapse}
            aria-label={collapseLabel}
            title={collapseLabel}
            className="ml-auto shrink-0 rounded px-2 py-1 text-slate-500 hover:bg-white/5 hover:text-slate-200"
          >
            ⟩
          </button>
        )}
      </header>
      <div className={`min-h-0 flex-1 flex-col ${tab === "chat" ? "flex" : "hidden"}`}>
        <ChatView />
      </div>
      <div className={`min-h-0 flex-1 flex-col ${tab === "run" ? "flex" : "hidden"}`}>
        <RunView />
      </div>
      <div className={`min-h-0 flex-1 flex-col ${tab === "inspect" ? "flex" : "hidden"}`}>
        <Inspector />
      </div>
      <Composer />
    </div>
  );
}

const PANEL_BG = "bg-[#0a0b10]/95 backdrop-blur";

/** >=1280: docked right, resizable by its left edge, collapsible to a rail. */
function RightDock() {
  const [width, setWidth] = useState(400);
  const [collapsed, setCollapsed] = useState(false);
  const drag = useRef<{ x: number; w: number } | null>(null);

  const onDown = (e: RPointerEvent) => {
    drag.current = { x: e.clientX, w: width };
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onMove = (e: RPointerEvent) => {
    if (!drag.current) return;
    const max = Math.min(720, window.innerWidth - 480);
    setWidth(Math.round(Math.min(max, Math.max(320, drag.current.w + drag.current.x - e.clientX))));
  };
  const onUp = () => (drag.current = null);

  if (collapsed) {
    return (
      <aside className={`flex h-full w-11 shrink-0 flex-col items-center border-l border-white/5 py-2 ${PANEL_BG}`} data-testid="dock" data-mode="dock" data-collapsed="true">
        <button
          data-testid="dock-expand"
          onClick={() => setCollapsed(false)}
          className="rounded px-2 py-1 text-slate-400 hover:bg-white/5 hover:text-slate-100"
          title="Open chat"
          aria-label="Open chat"
        >
          ⟨
        </button>
        <span className="mt-3 text-[10px] uppercase tracking-widest text-slate-500 [writing-mode:vertical-rl]">Chat</span>
      </aside>
    );
  }
  return (
    <aside
      data-testid="dock"
      data-mode="dock"
      style={{ width }}
      className={`relative flex h-full shrink-0 border-l border-white/5 ${PANEL_BG}`}
    >
      <div
        data-testid="dock-resize"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-violet-400/30"
        title="Drag to resize"
      />
      <DockPanel onCollapse={() => setCollapsed(true)} collapseLabel="Collapse chat" />
    </aside>
  );
}

/** 768-1279: slide-over drawer above the canvas. */
function Drawer() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <aside
        data-testid="dock"
        data-mode="drawer"
        data-open={open}
        aria-hidden={!open}
        className={`fixed inset-y-0 right-0 z-40 flex w-[min(400px,calc(100vw-56px))] border-l border-white/10 shadow-2xl transition-transform duration-200 ${PANEL_BG} ${open ? "translate-x-0" : "pointer-events-none translate-x-full"}`}
      >
        <DockPanel onCollapse={() => setOpen(false)} collapseLabel="Close chat" />
      </aside>
      {!open && (
        <button
          data-testid="drawer-toggle"
          onClick={() => setOpen(true)}
          className="fixed bottom-5 right-5 z-40 rounded-full bg-violet-500 px-4 py-2.5 text-sm font-medium text-white shadow-xl hover:bg-violet-400"
        >
          Chat
        </button>
      )}
    </>
  );
}

/** <768: bottom sheet in the layout flow (canvas shrinks above it), drag handle with snap points. */
function Sheet() {
  const snaps = useCallback(() => [124, Math.round(window.innerHeight * 0.5), Math.round(window.innerHeight * 0.85)], []);
  const [height, setHeight] = useState(() => snaps()[1]);
  const drag = useRef<{ y: number; h: number; moved: boolean } | null>(null);

  const onDown = (e: RPointerEvent) => {
    drag.current = { y: e.clientY, h: height, moved: false };
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dy = d.y - e.clientY;
    if (Math.abs(dy) > 4) d.moved = true;
    const [min, , max] = snaps();
    setHeight(Math.min(max, Math.max(min, d.h + dy)));
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const s = snaps();
    if (!d.moved) {
      // tap cycles collapsed -> half -> full -> collapsed
      const i = s.findIndex((v) => Math.abs(v - height) < 8);
      setHeight(s[(i + 1) % s.length]);
      return;
    }
    setHeight(s.reduce((best, v) => (Math.abs(v - height) < Math.abs(best - height) ? v : best), s[0]));
  };

  return (
    <aside
      data-testid="dock"
      data-mode="sheet"
      style={{ height }}
      className={`relative z-30 flex w-full shrink-0 flex-col rounded-t-2xl border-t border-white/10 shadow-[0_-12px_32px_rgba(0,0,0,0.5)] ${PANEL_BG}`}
    >
      <div
        data-testid="sheet-handle"
        role="slider"
        aria-label="Resize chat sheet"
        aria-valuenow={height}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        className="flex h-5 shrink-0 cursor-row-resize touch-none items-center justify-center"
      >
        <span className="h-1 w-10 rounded-full bg-white/25" />
      </div>
      <div className="min-h-0 flex-1">
        <DockPanel />
      </div>
    </aside>
  );
}

export function Dock({ mode }: { mode: LayoutMode }) {
  if (mode === "dock") return <RightDock />;
  if (mode === "drawer") return <Drawer />;
  return <Sheet />;
}
