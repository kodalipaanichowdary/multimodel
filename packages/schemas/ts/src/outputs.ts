import { z } from "zod";
import { PlanStepSchema } from "./events";

// Mirrors packages/schemas/python/pos_schemas/outputs.py (shape only; run-context checks are server-side).

const url = z.string().max(2000).regex(/^https?:\/\/[^\s]+$/);

export const PlanSchema = z
  .object({ search_query: z.string().min(2).max(200), steps: z.array(PlanStepSchema).min(1).max(8) })
  .strict();

export const SourceSchema = z
  .object({ url, title: z.string().max(300).default(""), snippet: z.string().max(1000).default("") })
  .strict();

export const ResearchResultSchema = z
  .object({ summary: z.string().max(3000), sources: z.array(SourceSchema).max(10), confidence: z.number().min(0).max(1) })
  .strict();

export const DraftSchema = z
  .object({
    answer: z.string().min(1).max(4000),
    citations: z.array(z.string().regex(/^https?:\/\/[^\s]+$/, "citation is not an http(s) URL")).max(10),
  })
  .strict();

export const VerdictSchema = z.object({ passed: z.boolean(), issues: z.array(z.string()).max(50).default([]) }).strict();

export const OutputSchemas = {
  Plan: PlanSchema,
  Source: SourceSchema,
  ResearchResult: ResearchResultSchema,
  Draft: DraftSchema,
  Verdict: VerdictSchema,
} as const;

export type Plan = z.infer<typeof PlanSchema>;
export type Source = z.infer<typeof SourceSchema>;
export type ResearchResult = z.infer<typeof ResearchResultSchema>;
export type Draft = z.infer<typeof DraftSchema>;
export type Verdict = z.infer<typeof VerdictSchema>;
