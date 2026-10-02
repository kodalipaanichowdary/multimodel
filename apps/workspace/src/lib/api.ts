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

export async function submitTask(prompt: string): Promise<string> {
  const res = await fetch(`${BASE}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  return (await json(res, z.object({ task_id: z.string() }))).task_id;
}
