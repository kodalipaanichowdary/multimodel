import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PREFIX = "pos-e2e-";
const STALE_MS = 60 * 60 * 1000;

/**
 * One fresh, empty temp dir per Playwright run (p2 SQLite/memory/audit DBs, prod build output).
 *
 * It used to be `pos-e2e-${process.pid}`: Windows reuses PIDs, so a later run could reopen an
 * earlier run's pos.db and the history restore showed that run's tasks too (G2.10 flake: two
 * "(persist check)" messages after reload). mkdtemp names are unique and the dir starts empty.
 *
 * The config file is evaluated by the runner and again by each worker; the runner creates the
 * dir and workers inherit it through the environment, so all processes agree on one path.
 *
 * Cleanup: a run cannot delete its own dir (Playwright's teardown runs before the API server
 * exits, and Windows keeps the open SQLite files locked), so each new run sweeps our own dirs
 * older than an hour. Best effort: anything locked or recent is left alone.
 */
export function runDir(env: NodeJS.ProcessEnv = process.env, base = os.tmpdir(), now = Date.now()): string {
  const existing = env.POS_E2E_TMP;
  if (existing && fs.existsSync(existing)) return existing;
  sweepStale(base, now);
  const dir = fs.mkdtempSync(path.join(base, PREFIX));
  env.POS_E2E_TMP = dir;
  return dir;
}

export function sweepStale(base: string, now = Date.now()): string[] {
  const removed: string[] = [];
  for (const name of fs.readdirSync(base)) {
    if (!name.startsWith(PREFIX)) continue;
    const p = path.join(base, name);
    try {
      const st = fs.statSync(p);
      if (!st.isDirectory() || now - st.mtimeMs < STALE_MS) continue;
      fs.rmSync(p, { recursive: true, force: true });
      removed.push(p);
    } catch {
      /* locked or vanished: leave it */
    }
  }
  return removed;
}
