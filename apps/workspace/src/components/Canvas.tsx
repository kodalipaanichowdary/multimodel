import { useCallback, useMemo, useRef } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useShallow } from "zustand/react/shallow";
import { useGraph } from "../store/graph";
import { DotNode, type DotData } from "./DotNode";
import { HoverTag, type HoverTagHandle } from "./HoverTag";
import type { EdgeKind } from "@pos/schemas";

const nodeTypes = { dot: DotNode };

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
  const onPaneClick = useCallback(() => {
    closePopup();
    select(null);
  }, [closePopup, select]);

  return (
    <div
      className="absolute inset-0"
      data-testid="canvas"
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
        onMoveStart={closePopup}
        nodesConnectable={false}
        fitView
        fitViewOptions={{ padding: 0.35, maxZoom: 1.4 }}
        minZoom={0.2}
        maxZoom={3}
        proOptions={{ hideAttribution: false }}
        colorMode="dark"
      >
        <Background variant={BackgroundVariant.Dots} gap={28} size={1} color="#1c2030" />
        <Controls showInteractive={false} position="bottom-left" />
      </ReactFlow>
      <HoverTag ref={tag} />
    </div>
  );
}
