import { describe, expect, it } from "vitest";
import { parseApiError } from "./api";

describe("parseApiError (server errors shown inline in add-agent form)", () => {
  it("409 string detail -> form-level", () => {
    const e = parseApiError(409, { detail: "agent 'critic' already exists" });
    expect(e.fields).toEqual({ "": ["agent 'critic' already exists"] });
  });

  it("422 FastAPI detail -> per-field (body prefix stripped)", () => {
    const e = parseApiError(422, {
      detail: [
        { loc: ["body", "id"], msg: "String should match pattern" },
        { loc: ["body", "model_profile", "model"], msg: "too short" },
        { loc: ["body", "id"], msg: "second" },
      ],
    });
    expect(e.fields).toEqual({ id: ["String should match pattern", "second"], "model_profile.model": ["too short"] });
    expect(e.status).toBe(422);
  });

  it("unknown body -> generic", () => {
    expect(parseApiError(500, null).fields).toEqual({ "": ["HTTP 500"] });
  });
});
