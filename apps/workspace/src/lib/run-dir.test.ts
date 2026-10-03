import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDir, sweepStale } from "../../e2e/run-dir";

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("e2e run dir (G2.10 root cause: stale pos.db via PID reuse)", () => {
  it("never reuses an earlier run's dir, even one named after this PID", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "rundir-test-"));
    made.push(base);
    const stale = path.join(base, `pos-e2e-${process.pid}`); // what the old config would reopen
    fs.mkdirSync(stale);
    fs.writeFileSync(path.join(stale, "pos.db"), "old run");

    const dir = runDir({}, base);
    expect(dir).not.toBe(stale);
    expect(fs.readdirSync(dir)).toEqual([]); // fresh and empty
    expect(runDir({}, base)).not.toBe(dir); // every new run gets its own
  });

  it("sweeps only our own dirs older than an hour", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "rundir-test-"));
    made.push(base);
    const old = path.join(base, "pos-e2e-old");
    const recent = path.join(base, "pos-e2e-recent");
    const other = path.join(base, "someone-else");
    for (const d of [old, recent, other]) fs.mkdirSync(d);
    const now = Date.now();
    const twoHoursAgo = new Date(now - 2 * 3600_000);
    fs.utimesSync(old, twoHoursAgo, twoHoursAgo);
    fs.utimesSync(other, twoHoursAgo, twoHoursAgo);
    expect(sweepStale(base, now)).toEqual([old]);
    expect(fs.existsSync(recent) && fs.existsSync(other)).toBe(true);
  });

  it("runner and workers agree on one dir through the environment", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "rundir-test-"));
    made.push(base);
    const env: NodeJS.ProcessEnv = {};
    const runner = runDir(env, base);
    expect(env.POS_E2E_TMP).toBe(runner);
    expect(runDir(env, base)).toBe(runner); // a worker re-evaluating the config
  });
});
