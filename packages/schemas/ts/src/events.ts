import { z } from "zod";

// Mirrors packages/schemas/python/pos_schemas/events.py — keep 1:1.

const id = z.string().min(1);
const nonNegInt = z.number().int().nonnegative();

export const PlanStepSchema = z.object({ agent_id: id, goal: id }).strict();

export const PayloadSchemas = {
  "task.created": z.object({ prompt: z.string().min(1).max(4000) }).strict(),
  "task.planned": z.object({ steps: z.array(PlanStepSchema).min(1) }).strict(),
  "agent.started": z.object({ agent_id: id, parent_id: z.string().nullable().default(null) }).strict(),
  "agent.thinking": z.object({ agent_id: id, message: z.string() }).strict(),
  "agent.completed": z.object({ agent_id: id, summary: z.string() }).strict(),
  "tool.started": z
    .object({ agent_id: id, tool_id: id, call_id: id, args: z.record(z.unknown()).default({}) })
    .strict(),
  "tool.completed": z
    .object({
      agent_id: id,
      tool_id: id,
      call_id: id,
      duration_ms: nonNegInt,
      result_preview: z.string().default(""),
    })
    .strict(),
  "tool.failed": z.object({ agent_id: id, tool_id: id, call_id: id, error: id }).strict(),
  "approval.requested": z
    .object({ approval_id: id, agent_id: id, tool_id: id, reason: id })
    .strict(),
  "approval.granted": z.object({ approval_id: id, by: id }).strict(),
  "approval.denied": z.object({ approval_id: id, by: id, reason: z.string().default("") }).strict(),
  "model.metrics": z
    .object({
      agent_id: id,
      model: id,
      attempt: z.number().int().min(1),
      ttft_ms: nonNegInt,
      tok_s: z.number().nonnegative(),
      total_ms: nonNegInt,
      prompt_tokens: nonNegInt,
      completion_tokens: nonNegInt,
    })
    .strict(),
  "artifact.created": z
    .object({ artifact_id: id, agent_id: id, title: id, mime: id, content: z.string() })
    .strict(),
  "execution.completed": z
    .object({ duration_ms: nonNegInt, artifact_ids: z.array(z.string()).default([]) })
    .strict(),
  "execution.failed": z.object({ error: id, agent_id: z.string().nullable().default(null) }).strict(),
} as const;

export type EventType = keyof typeof PayloadSchemas;
export const EVENT_TYPES = Object.keys(PayloadSchemas) as EventType[];

const envelope = {
  id,
  task_id: id,
  seq: nonNegInt,
  ts: z.string().datetime({ offset: true }),
};

function eventOf<T extends EventType>(type: T) {
  return z.object({ ...envelope, type: z.literal(type), payload: PayloadSchemas[type] }).strict();
}

export const EventSchema = z.discriminatedUnion("type", [
  eventOf("task.created"),
  eventOf("task.planned"),
  eventOf("agent.started"),
  eventOf("agent.thinking"),
  eventOf("agent.completed"),
  eventOf("tool.started"),
  eventOf("tool.completed"),
  eventOf("tool.failed"),
  eventOf("approval.requested"),
  eventOf("approval.granted"),
  eventOf("approval.denied"),
  eventOf("model.metrics"),
  eventOf("artifact.created"),
  eventOf("execution.completed"),
  eventOf("execution.failed"),
]);

export type PosEvent = z.infer<typeof EventSchema>;
export type EventOf<T extends EventType> = Extract<PosEvent, { type: T }>;

export function parseEvent(raw: unknown) {
  return EventSchema.safeParse(raw);
}
