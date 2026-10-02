// Shared helpers for scripts/*.mjs. Node built-ins only; Windows, macOS and Linux.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

export const IS_WIN = process.platform === "win32";
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const API_DIR = path.join(ROOT, "apps", "api");
export const WEB_DIR = path.join(ROOT, "apps", "workspace");
export const VENV = path.join(API_DIR, ".venv");
export const VENV_BIN = path.join(VENV, IS_WIN ? "Scripts" : "bin");
export const VENV_PY = path.join(VENV_BIN, IS_WIN ? "python.exe" : "python");
export const VITE = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
export const NPM = IS_WIN ? "npm.cmd" : "npm";

/**
 * Windows: spawn detached so libuv does not put the child in its job object. With the
 * Microsoft Store Python, AssignProcessToJobObject fails (87) and libuv aborts Node (exit 3).
 * Detached children are stopped explicitly by killTree (taskkill /T).
 */
const DETACH = true;

const COLORS = { api: 36, ui: 35, check: 33 };
export const tag = (name) => (process.stdout.isTTY ? `\x1b[${COLORS[name] ?? 37}m[${name}]\x1b[0m` : `[${name}]`);

/** .env (optional) on top of .env.example defaults; real environment wins. */
export function loadEnv() {
  const parse = (file) => {
    if (!existsSync(file)) return {};
    const out = {};
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !line.trimStart().startsWith("#")) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    return out;
  };
  return { ...parse(path.join(ROOT, ".env.example")), ...parse(path.join(ROOT, ".env")), ...process.env };
}

export function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

export function requireVenv() {
  if (!existsSync(VENV_PY)) die(`Python venv missing (${path.relative(ROOT, VENV_PY)}). Run: npm run setup`);
  if (!existsSync(VITE)) die("node_modules missing. Run: npm run setup");
}

/** True if something is already accepting connections (or bound) on host:port. */
export function portInUse(port, host = "127.0.0.1") {
  const connect = new Promise((resolve) => {
    const s = net.connect({ port, host });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
    s.setTimeout(500, () => (s.destroy(), resolve(false)));
  });
  const bind = new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(true));
    srv.once("listening", () => srv.close(() => resolve(false)));
    srv.listen(port, host);
  });
  return Promise.all([connect, bind]).then(([a, b]) => a || b);
}

export async function assertPortsFree(ports) {
  for (const [name, port] of ports) {
    if (await portInUse(Number(port))) {
      const hint = IS_WIN
        ? `Get-NetTCPConnection -LocalPort ${port} -State Listen | Select OwningProcess`
        : `lsof -iTCP:${port} -sTCP:LISTEN`;
      die(`${name} port ${port} is already in use. Stop whatever holds it (${hint}) or set ${name}_PORT in .env`);
    }
  }
}

/** Spawn a long-running child with line-prefixed output. Own process group on POSIX. */
export function startService(name, cmd, args, { cwd, env }) {
  const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: DETACH, windowsHide: true });
  for (const stream of [child.stdout, child.stderr]) {
    readline.createInterface({ input: stream }).on("line", (l) => console.log(`${tag(name)} ${l}`));
  }
  return child;
}

/** Kill a child and everything it spawned (uvicorn --reload forks a worker). */
export function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (IS_WIN) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }, 3000).unref();
  }
}

/**
 * Run services until Ctrl+C / SIGTERM / one of them dies; then stop all of them.
 * Resolves only by exiting the process.
 */
export function supervise(services) {
  let stopping = false;
  const stop = (code, why) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${why} — stopping ${services.map((s) => s.name).join(" + ")}…`);
    for (const s of services) killTree(s.child);
    const alive = () => services.some((s) => s.child.exitCode === null && s.child.signalCode === null);
    const t0 = Date.now();
    const wait = setInterval(() => {
      if (!alive() || Date.now() - t0 > 8000) {
        clearInterval(wait);
        console.log(alive() ? "warning: a child did not exit in 8s" : "all processes stopped.");
        process.exit(code);
      }
    }, 100);
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
    try {
      process.on(sig, () => stop(0, `received ${sig}`));
    } catch {
      /* signal not supported on this platform */
    }
  }
  for (const s of services) {
    s.child.on("exit", (code, signal) => {
      if (!stopping) stop(code || 1, `${s.name} exited unexpectedly (code ${code ?? signal})`);
    });
    s.child.on("error", (e) => !stopping && stop(1, `${s.name} failed to start: ${e.message}`));
  }
}

/** Run to completion, inheriting stdio. Returns exit code. */
export function runInherit(cmd, args, { cwd = ROOT, env = process.env } = {}) {
  // .cmd shims (npm.cmd, npx.cmd) need a shell on Windows
  const shell = IS_WIN && /\.cmd$/i.test(cmd);
  const r = spawnSync(cmd, args, { cwd, env, stdio: "inherit", shell, detached: IS_WIN && !shell, windowsHide: true });
  if (r.error) {
    console.error(r.error.message);
    return 1;
  }
  return r.status ?? 1;
}
