import { z } from "zod";

// Mirrors packages/schemas/python/pos_schemas/graph.py

export const NodeKindSchema = z.enum(["agent", "tool", "memory", "task", "artifact"]);
export const NodeStateSchema = z.enum([
  "idle",
  "queued",
  "thinking",
  "running",
  "waiting_approval",
  "completed",
  "error",
]);
export const EdgeKindSchema = z.enum(["delegates", "calls", "produces", "reads"]);

export const PositionSchema = z.object({ x: z.number(), y: z.number() }).strict();

export const NodeSchema = z
  .object({
    id: z.string().min(1),
    kind: NodeKindSchema,
    label: z.string().min(1),
    state: NodeStateSchema.default("idle"),
    ref_id: z.string().min(1),
    position: PositionSchema.nullable().optional(),
  })
  .strict();

export const EdgeSchema = z
  .object({
    id: z.string().min(1),
    source: z.string().min(1),
    target: z.string().min(1),
    kind: EdgeKindSchema,
    active: z.boolean().default(false),
  })
  .strict();

export type NodeKind = z.infer<typeof NodeKindSchema>;
export type NodeState = z.infer<typeof NodeStateSchema>;
export type EdgeKind = z.infer<typeof EdgeKindSchema>;
export type GraphNode = z.infer<typeof NodeSchema>;
export type GraphEdge = z.infer<typeof EdgeSchema>;
