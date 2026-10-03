import { z } from "zod";
import { AgentDefinitionSchema, type AgentDefinition } from "@pos/schemas";

const BASE = "/api";

async function json<T>(res: Response, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  return schema.parse(await res.json());
}

export async function fetchAgents(): Promise<AgentDefinition[]> {
  return json(await fetch(`${BASE}/agents`), z.array(AgentDefinitionSchema));
}

export async function submitTask(prompt: string, selected: string[] = [], projectId = "default"): Promise<string> {
  const body: Record<string, unknown> = { prompt };
  if (selected.length) body.selected = selected;
  if (projectId !== "default") body.project_id = projectId;
  const res = await fetch(`${BASE}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await json(res, z.object({ task_id: z.string() }))).task_id;
}

/** Field path ("" = form-level) -> messages. */
export type FieldErrors = Record<string, string[]>;

export class ApiError extends Error {
  constructor(
    public status: number,
    public fields: FieldErrors,
  ) {
    super(Object.values(fields).flat().join("; ") || `HTTP ${status}`);
  }
}

const FastApiDetail = z.union([
  z.string(),
  z.array(z.object({ loc: z.array(z.union([z.string(), z.number()])), msg: z.string() })),
]);

/** Normalise FastAPI error bodies: 409/404 `{detail: str}`, 422 `{detail: [{loc, msg}]}`. */
export function parseApiError(status: number, body: unknown): ApiError {
  const parsed = z.object({ detail: FastApiDetail }).safeParse(body);
  if (!parsed.success) return new ApiError(status, { "": [`HTTP ${status}`] });
  const d = parsed.data.detail;
  if (typeof d === "string") return new ApiError(status, { "": [d] });
  const fields: FieldErrors = {};
  for (const e of d) {
    const key = e.loc.filter((p) => p !== "body").join(".");
    (fields[key] ??= []).push(e.msg);
  }
  return new ApiError(status, fields);
}

export async function createAgent(agent: AgentDefinition): Promise<AgentDefinition> {
  const res = await fetch(`${BASE}/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(agent),
  });
  if (!res.ok) throw parseApiError(res.status, await res.json().catch(() => null));
  return AgentDefinitionSchema.parse(await res.json());
}

export async function decideApproval(approvalId: string, decision: "allow" | "deny"): Promise<void> {
  const res = await fetch(`${BASE}/approvals/${encodeURIComponent(approvalId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision }),
  });
  if (!res.ok) throw parseApiError(res.status, await res.json().catch(() => null));
}

export async function killTask(taskId: string): Promise<void> {
  const res = await fetch(`${BASE}/tasks/${encodeURIComponent(taskId)}/kill`, { method: "POST" });
  if (!res.ok) throw parseApiError(res.status, await res.json().catch(() => null));
}

const TaskSummarySchema = z.object({ task_id: z.string(), prompt: z.string(), status: z.string(), events: z.number() });

/** Persisted event log, oldest run first, each run in seq order (raw JSON; zod-validated on ingest). */
export async function fetchHistory(limit = 20): Promise<unknown[]> {
  const tasks = await json(await fetch(`${BASE}/tasks?limit=${limit}`), z.array(TaskSummarySchema));
  const out: unknown[] = [];
  for (const t of [...tasks].reverse()) {
    const res = await fetch(`${BASE}/tasks/${encodeURIComponent(t.task_id)}/events`);
    if (res.ok) out.push(...((await res.json()) as unknown[]));
  }
  return out;
}

export const MemoryItemSchema = z.object({
  id: z.string(),
  layer: z.enum(["personal", "project", "execution"]),
  project_id: z.string(),
  task_id: z.string().nullable(),
  text: z.string(),
  source: z.string(),
  created_at: z.number(),
  embedded: z.boolean(),
  score: z.number().nullable(),
});
export type MemoryItem = z.infer<typeof MemoryItemSchema>;

export async function listMemory(projectId: string, q?: string): Promise<MemoryItem[]> {
  const params = new URLSearchParams({ project_id: projectId });
  if (q) params.set("q", q);
  return json(await fetch(`${BASE}/memory?${params}`), z.array(MemoryItemSchema));
}

export async function deleteMemory(id: string, projectId: string): Promise<void> {
  const res = await fetch(`${BASE}/memory/${encodeURIComponent(id)}?project_id=${encodeURIComponent(projectId)}`, { method: "DELETE" });
  if (!res.ok) throw parseApiError(res.status, await res.json().catch(() => null));
}
