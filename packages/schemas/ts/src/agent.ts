import { z } from "zod";

// Mirrors packages/schemas/python/pos_schemas/agent.py

export const PermissionSchema = z.enum([
  "net.read",
  "fs.read",
  "fs.write",
  "terminal.exec",
  "memory.read",
  "memory.write",
]);

export const MemoryConfigSchema = z
  .object({
    scope: z.enum(["none", "task", "project", "global"]).default("task"),
    kind: z.enum(["none", "kv", "vector"]).default("none"),
  })
  .strict();

export const ModelProfileSchema = z
  .object({
    provider: z.enum(["ollama", "litellm", "cloud"]).default("ollama"),
    model: z.string().min(1),
    temperature: z.number().min(0).max(2).default(0),
    max_tokens: z.number().int().positive().max(32768).default(1024),
  })
  .strict();

export const AgentDefinitionSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{1,47}$/),
    name: z.string().min(1).max(64),
    description: z.string().min(1).max(500),
    capabilities: z.array(z.string()).min(1),
    tools: z.array(z.string()).default([]),
    memory: MemoryConfigSchema.default({}),
    model_profile: ModelProfileSchema,
    permissions: z.array(PermissionSchema).default([]),
  })
  .strict();

export type Permission = z.infer<typeof PermissionSchema>;
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;
