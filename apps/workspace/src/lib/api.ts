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

export async function submitTask(prompt: string, selected: string[] = []): Promise<string> {
  const res = await fetch(`${BASE}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(selected.length ? { prompt, selected } : { prompt }),
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
