import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { motion } from "framer-motion";
import type { NodeKind } from "@pos/schemas";
import { KIND_COLOR, STATE_COLOR } from "../lib/theme";
import { useGraph } from "../store/graph";
import { hash01 } from "../lib/layout";

const SIZE: Record<NodeKind, number> = { agent: 30, task: 26, tool: 20, memory: 20, artifact: 22 };

const centered = {
  top: "50%",
  left: "50%",
  transform: "translate(-50%,-50%)",
  opacity: 0,
  width: 1,
  height: 1,
  minWidth: 0,
  minHeight: 0,
  border: 0,
  pointerEvents: "none" as const,
};

export type DotData = { nodeId: string };

function DotNodeImpl({ data, selected }: NodeProps & { data: DotData }) {
  const node = useGraph((s) => s.nodes[data.nodeId]);
  if (!node) return null;
  const size = SIZE[node.kind];
  const color = KIND_COLOR[node.kind];
  const ring = STATE_COLOR[node.state];
  const h = hash01(node.id);
  const live = node.state === "running" || node.state === "thinking" || node.state === "waiting_approval";

  return (
    <div
      className="pos-drift relative flex flex-col items-center"
      style={{
        animationDuration: `${6 + h * 5}s`,
        animationDelay: `${-h * 10}s`,
      }}
      data-testid={`node-${node.id}`}
      data-state={node.state}
      data-kind={node.kind}
    >
      <div className="relative" style={{ width: size, height: size }}>
        <Handle type="target" position={Position.Top} style={centered} isConnectable={false} />
        <Handle type="source" position={Position.Bottom} style={centered} isConnectable={false} />
        {live && (
          <span
            className={node.state === "thinking" ? "pos-ping-slow" : "pos-ping"}
            style={{ width: size + 18, height: size + 18, borderColor: ring }}
          />
        )}
        <motion.div
          key={node.state}
          initial={{ scale: 0.7 }}
          animate={{ scale: 1 }}
          transition={{ type: "spring", stiffness: 420, damping: 18 }}
          className="h-full w-full rounded-full"
          style={{
            background: `radial-gradient(circle at 35% 30%, #fff8, ${color} 45%, ${color}88)`,
            boxShadow: `0 0 0 3px ${ring}, 0 0 ${live ? 22 : 10}px ${live ? ring : color + "66"}${
              selected ? ", 0 0 0 6px #ffffff33" : ""
            }`,
          }}
        />
      </div>
      <span className="pointer-events-none mt-1.5 select-none whitespace-nowrap text-[10px] font-medium tracking-wide text-slate-400/80">
        {node.label}
      </span>
    </div>
  );
}

export const DotNode = memo(DotNodeImpl);
