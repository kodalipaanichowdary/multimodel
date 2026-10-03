import { useCallback, useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeMouseHandler,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useShallow } from "zustand/react/shallow";
import { useGraph } from "../store/graph";
import { DotNode, type DotData } from "./DotNode";
import { HoverTag, type HoverTagHandle } from "./HoverTag";
import type { EdgeKind } from "@pos/schemas";

const nodeTypes = { dot: DotNode };
const FIT = { padding: 0.35, maxZoom: 1.4 };

const EDGE_COLOR: Record<EdgeKind, string> = {
  delegates: "#a78bfa",
  calls: "#fbbf24",
  produces: "#34d399",
  reads: "#f472b6",
};

export function Canvas() {
  const { nodes, edges } = useGraph(useShallow((s) => ({ nodes: s.nodes, edges: s.edges })));
  const moveNode = useGraph((s) => s.moveNode);
  const openPopup = useGraph((s) => s.openPopup);
  const closePopup = useGraph((s) => s.closePopup);
  const select = useGraph((s) => s.select);
  const tag = useRef<HoverTagHandle>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const { fitView } = useReactFlow();
  // G3.2: refit when the canvas is resized (layout switch / window resize) unless the user
  // has panned or zoomed by hand; the Controls "fit view" button hands control back.
  const userMoved = useRef(false);

  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let raf = 0;
    let last = "";
    const ro = new ResizeObserver(([entry]) => {
      const size = `${Math.round(entry.contentRect.width)}x${Math.round(entry.contentRect.height)}`;
      if (size === last) return;
      const first = last === "";
      last = size;
      if (first || userMoved.current) return; // initial fit is done by the fitView prop
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => fitView(FIT));
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [fitView]);

  // Stable `data` objects so memoized DotNodes skip re-render on unrelated changes.
  const dataCache = useRef(new Map<string, DotData>());
  const rfNodes: Node<DotData>[] = useMemo(
    () =>
      Object.values(nodes).map((n) => {
        let data = dataCache.current.get(n.id);
        if (!data) dataCache.current.set(n.id, (data = { nodeId: n.id }));
        return { id: n.id, type: "dot", position: n.position, data, origin: [0.5, 0.25] };
      }),
    [nodes],
  );

  const rfEdges: Edge[] = useMemo(
    () =>
      Object.values(edges).map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        animated: e.active,
        type: "default",
        style: {
          stroke: EDGE_COLOR[e.kind],
          strokeWidth: e.active ? 2 : 1.25,
          opacity: e.active ? 0.95 : 0.3,
        },
        data: { kind: e.kind },
      })),
    [edges],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<DotData>>[]) => {
      for (const c of changes) if (c.type === "position" && c.position) moveNode(c.id, c.position);
    },
    [moveNode],
  );

  const onNodeClick: NodeMouseHandler = useCallback(
    (e, n) => openPopup(n.id, e.clientX, e.clientY),
    [openPopup],
  );
  const onEnter: NodeMouseHandler = useCallback((e, n) => tag.current?.show(n.id, e), []);
  const onLeave: NodeMouseHandler = useCallback(() => tag.current?.hide(), []);
  // G3.4: keyboard users open a node's popup with Enter/Space on the focused node.
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const el = (e.target as HTMLElement).closest<HTMLElement>(".react-flow__node");
      const id = el?.dataset.id;
      if (!el || !id) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      openPopup(id, r.left + r.width / 2, r.top + r.height / 2);
    },
    [openPopup],
  );
  const onPaneClick = useCallback(() => {
    closePopup();
    select(null);
  }, [closePopup, select]);

  return (
    <div
      className="absolute inset-0"
      data-testid="canvas"
      ref={wrap}
      onKeyDown={onKeyDown}
      onMouseMove={(e) => tag.current?.move(e.clientX, e.clientY)}
    >
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={onNodeClick}
        onNodeMouseEnter={onEnter}
        onNodeMouseLeave={onLeave}
        onNodeDragStart={() => tag.current?.hide()}
        onPaneClick={onPaneClick}
        onMoveStart={(event) => {
          closePopup();
          if (event) {
            userMoved.current = true; // a real pan/zoom (programmatic moves have no event)
            wrap.current?.setAttribute("data-user-moved", "true");
          }
        }}
        nodesConnectable={false}
        fitView
        fitViewOptions={FIT}
        minZoom={0.2}
        maxZoom={3}
        proOptions={{ hideAttribution: false }}
        colorMode="dark"
      >
        <Background variant={BackgroundVariant.Dots} gap={28} size={1} color="#1c2030" />
        <Controls
          showInteractive={false}
          position="bottom-left"
          onFitView={() => {
            userMoved.current = false;
            wrap.current?.setAttribute("data-user-moved", "false");
          }}
        />
      </ReactFlow>
      <HoverTag ref={tag} />
    </div>
  );
}
