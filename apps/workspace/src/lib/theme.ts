import type { NodeKind, NodeState, Permission } from "@pos/schemas";

export const KIND_COLOR: Record<NodeKind, string> = {
  agent: "#a78bfa",
  tool: "#fbbf24",
  memory: "#f472b6",
  task: "#38bdf8",
  artifact: "#34d399",
};

export const STATE_COLOR: Record<NodeState, string> = {
  idle: "#3f4456",
  queued: "#94a3b8",
  thinking: "#60a5fa",
  running: "#22d3ee",
  waiting_approval: "#f59e0b",
  completed: "#10b981",
  error: "#ef4444",
};

/** Permissions whose tools require human approval. */
export const DANGEROUS: ReadonlySet<Permission> = new Set(["fs.write", "terminal.exec"]);
