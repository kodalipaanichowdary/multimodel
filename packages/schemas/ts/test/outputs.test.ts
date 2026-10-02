import { describe, expect, it } from "vitest";
import fixtures from "../../fixtures/outputs.json";
import { OutputSchemas } from "../src";

type Name = keyof typeof OutputSchemas;

describe("output schemas (zod) vs shared fixtures", () => {
  it.each(fixtures.valid.map((c, i) => [`${c.model}-${i}`, c]))("accepts %s", (_n, c) => {
    const r = OutputSchemas[c.model as Name].safeParse(c.data);
    expect(r.success, JSON.stringify(!r.success && r.error.issues)).toBe(true);
  });
  it.each(fixtures.invalid.map((c) => [c.why, c]))("rejects: %s", (_w, c) => {
    expect(OutputSchemas[c.model as Name].safeParse(c.data).success).toBe(false);
  });
});
