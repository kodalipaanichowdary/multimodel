import { describe, expect, it } from "vitest";
import valid from "../../fixtures/events.valid.json";
import invalid from "../../fixtures/events.invalid.json";
import { EVENT_TYPES, EventSchema, AgentDefinitionSchema } from "../src";

describe("EventSchema (zod) vs shared fixtures", () => {
  it("covers every event type in valid fixtures", () => {
    const seen = new Set(valid.map((e) => e.type));
    expect([...seen].sort()).toEqual([...EVENT_TYPES].sort());
  });

  it.each(valid.map((e) => [e.id, e]))("accepts valid %s", (_id, e) => {
    const r = EventSchema.safeParse(e);
    expect(r.success, JSON.stringify(!r.success && r.error.issues)).toBe(true);
  });

  it.each(invalid.map((c) => [c.why, c.event]))("rejects: %s", (_why, e) => {
    expect(EventSchema.safeParse(e).success).toBe(false);
  });

  it("has exactly the 13 contract event types", () => {
    expect(EVENT_TYPES).toHaveLength(13);
  });
});

describe("AgentDefinitionSchema", () => {
  const base = {
    id: "research",
    name: "Research",
    description: "Finds things",
    capabilities: ["search"],
    model_profile: { model: "llama3.2:3b" },
  };
  it("applies defaults", () => {
    const a = AgentDefinitionSchema.parse(base);
    expect(a.tools).toEqual([]);
    expect(a.memory).toEqual({ scope: "task", kind: "none" });
    expect(a.model_profile.temperature).toBe(0);
  });
  it("rejects bad id / unknown permission / extra keys", () => {
    expect(AgentDefinitionSchema.safeParse({ ...base, id: "Bad Id" }).success).toBe(false);
    expect(AgentDefinitionSchema.safeParse({ ...base, permissions: ["root"] }).success).toBe(false);
    expect(AgentDefinitionSchema.safeParse({ ...base, foo: 1 }).success).toBe(false);
  });
});
