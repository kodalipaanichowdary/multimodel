import { describe, expect, it } from "vitest";
import { EventSchema, type PosEvent } from "@pos/schemas";
import sequences from "../../../../packages/schemas/fixtures/mock_sequences.json";
import { liveStats, stripModel, stripSummary, type LiveStats } from "./projection";

// Fixture timestamps: BASE + seq * 250 ms (apps/api/scripts/gen_fixtures.py).
const HAPPY: PosEvent[] = sequences.happy.map((e) => EventSchema.parse(e));
const FAIL: PosEvent[] = sequences.fail.map((e) => EventSchema.parse(e));
const BASE = Date.parse(HAPPY[0].ts);
const run = (events: PosEvent[]) => ({ events, invalidDropped: 0 });

describe("liveStats", () => {
  it("happy, finished: event timestamps only", () => {
    expect(liveStats(run(HAPPY), 0, 0)).toEqual<LiveStats>({
      tools_running: 0,
      tools_done: 2,
      tools_failed: 0,
      events_per_sec: 4, // seq 14..21 have ts in (3250, 5250]
      elapsed_ms: 5250,
      done: true,
    });
  });

  it("finished runs ignore the browser clock entirely", () => {
    const a = liveStats(run(HAPPY), 0, 0);
    expect(liveStats(run(HAPPY), 9e15, -123456)).toEqual(a);
    expect(liveStats(run(FAIL), Date.now(), 42)).toEqual(liveStats(run(FAIL), 1, 1));
  });

  it("fail, finished", () => {
    expect(liveStats(run(FAIL), 0, 0)).toEqual<LiveStats>({
      tools_running: 0,
      tools_done: 0,
      tools_failed: 1,
      events_per_sec: 4, // seq 1..8 in (0, 2000]
      elapsed_ms: 2000,
      done: true,
    });
  });

  it("live: browser clock mapped to server time through the first-event offset", () => {
    const events = HAPPY.slice(0, 7); // seq 0..6, last ts BASE+1500, web_search running
    const offset = 3000; // browser clock 3 s ahead of the server
    const s = liveStats(run(events), BASE + 1600 + offset, offset);
    expect(s).toEqual<LiveStats>({
      tools_running: 1,
      tools_done: 0,
      tools_failed: 0,
      events_per_sec: 3.5, // 7 events in (-400, 1600]
      elapsed_ms: 1600,
      done: false,
    });
    // same server instant expressed with a different offset -> identical
    expect(liveStats(run(events), BASE + 1600 - 500, -500)).toEqual(s);
  });

  it("live: never reports less than the last event already seen", () => {
    expect(liveStats(run(HAPPY.slice(0, 7)), BASE + 1000, 0).elapsed_ms).toBe(1500);
  });

  it("sliding window drops old events", () => {
    // 2.5 s after last event (ts 1500): window (2000, 4000] is empty
    expect(liveStats(run(HAPPY.slice(0, 7)), BASE + 4000, 0).events_per_sec).toBe(0);
  });

  it("empty run", () => {
    expect(liveStats(run([]), 5, 5)).toMatchObject({ elapsed_ms: 0, events_per_sec: 0, done: false });
  });
});

describe("stripModel", () => {
  const at = (n: number) => stripModel(run(HAPPY.slice(0, n)));
  const states = (n: number) => at(n).dots.map((d) => d.state);

  it("no plan yet -> empty", () => {
    expect(at(3)).toEqual({ dots: [], activeIndex: -1, progress: 0 });
  });

  it("dots are planned agents in plan order", () => {
    expect(at(4).dots.map((d) => d.agent_id)).toEqual(["research", "writer", "validator"]);
    expect(at(4)).toMatchObject({ activeIndex: -1, progress: 0 });
    expect(states(4)).toEqual(["queued", "queued", "queued"]);
  });

  it("happy progression: exact activeIndex / progress", () => {
    expect(at(7)).toMatchObject({ activeIndex: 0, progress: 0 }); // research + web_search running
    expect(states(7)).toEqual(["running", "queued", "queued"]);
    expect(at(9)).toMatchObject({ activeIndex: -1, progress: 0.5 }); // research done, writer not started
    expect(at(12)).toMatchObject({ activeIndex: 1, progress: 0.5 }); // writer awaiting approval
    expect(states(12)).toEqual(["completed", "waiting_approval", "queued"]);
    expect(at(17)).toMatchObject({ activeIndex: 2, progress: 1 });
    expect(stripModel(run(HAPPY))).toEqual({
      dots: [
        { agent_id: "research", state: "completed" },
        { agent_id: "writer", state: "completed" },
        { agent_id: "validator", state: "completed" },
      ],
      activeIndex: -1,
      progress: 1,
    });
  });

  it("fail: pulse parks on the errored dot", () => {
    expect(stripModel(run(FAIL))).toEqual({
      dots: [
        { agent_id: "research", state: "error" },
        { agent_id: "writer", state: "queued" },
        { agent_id: "validator", state: "queued" },
      ],
      activeIndex: 0,
      progress: 0,
    });
  });
});

describe("stripSummary", () => {
  it("happy", () => {
    expect(stripSummary(run(HAPPY))).toEqual({
      ok: true,
      agents: 4,
      tools: 2,
      seconds: "5.3s",
      text: "✓ 4 agents · 2 tools · 5.3s",
    });
  });
  it("fail (singular tool)", () => {
    expect(stripSummary(run(FAIL))).toEqual({
      ok: false,
      agents: 2,
      tools: 1,
      seconds: "2.0s",
      text: "✗ 2 agents · 1 tool · 2.0s",
    });
  });
});
