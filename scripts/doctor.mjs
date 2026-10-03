// npm run doctor - preflight for real runs. Prints a fix per failure; exit 1 on any hard failure.
// Node built-ins only. Hard = breaks real answers. Warn = degrades something specific.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { IS_WIN, ROOT, VENV_PY, portInUse } from "./lib.mjs";

const OLLAMA = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const EMBED_MODEL = "nomic-embed-text";
const ALLOW_CPU = process.env.DOCTOR_ALLOW_CPU === "1";
const results = [];
const add = (level, check, detail, fix = "") => results.push({ level, check, detail, fix });

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", detached: IS_WIN, windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || r.error?.message || "").trim() };
}

async function http(url, opts = {}, ms = 6000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

function manifestModels() {
  const dir = path.join(ROOT, "agents");
  const models = new Set();
  for (const id of readdirSync(dir)) {
    const f = path.join(dir, id, "manifest.yaml");
    if (!existsSync(f)) continue;
    const m = readFileSync(f, "utf8").match(/model:\s*"?([^",}\s]+)"?/);
    if (m) models.add(m[1]);
  }
  return [...models];
}

// ------------------------------------------------------------------ runtimes
{
  const py = existsSync(VENV_PY) ? VENV_PY : IS_WIN ? "python" : "python3";
  const r = run(py, ["-c", "import sys;print('%d.%d.%d'%sys.version_info[:3])"]);
  const [maj, min] = (r.out || "0.0").split(".").map(Number);
  if (!r.ok) add("FAIL", "python", `not runnable (${py})`, "install Python >= 3.10 (python.org or Microsoft Store), then: npm run setup");
  else if (maj < 3 || (maj === 3 && min < 10)) add("FAIL", "python", `${r.out} < 3.10`, "install Python >= 3.10, then: npm run setup");
  else add("OK", "python", `${r.out}${existsSync(VENV_PY) ? " (apps/api/.venv)" : " (system; venv missing)"}`, existsSync(VENV_PY) ? "" : "npm run setup");
}
{
  const major = Number(process.versions.node.split(".")[0]);
  add(major >= 18 ? "OK" : "FAIL", "node", process.versions.node, major >= 18 ? "" : "install Node.js >= 18 (nodejs.org)");
}
{
  const name = run("git", ["-C", ROOT, "config", "user.name"]).out;
  const email = run("git", ["-C", ROOT, "config", "user.email"]).out;
  if (name && email) add("OK", "git identity", `${name} <${email}>`);
  else add("WARN", "git identity", "user.name / user.email not set", 'git config user.name "Your Name" && git config user.email "you@example.com"');
}

// ------------------------------------------------------------------ ollama
let ollamaUp = false;
let tags = [];
try {
  const v = await (await http(`${OLLAMA}/api/version`, {}, 3000)).json();
  tags = (await (await http(`${OLLAMA}/api/tags`)).json()).models.map((m) => m.name);
  ollamaUp = true;
  add("OK", "ollama up", `${OLLAMA} v${v.version}`);
} catch {
  add("FAIL", "ollama up", `no answer at ${OLLAMA}`, "start the Ollama tray app (Start menu > Ollama). Do not start `ollama serve` from a sandboxed shell: it may not see the GPU");
}

if (ollamaUp) {
  const want = [...manifestModels(), EMBED_MODEL];
  const have = (m) => tags.includes(m) || tags.includes(`${m}:latest`);
  const missing = want.filter((m) => !have(m));
  if (missing.length) add("FAIL", "models pulled", `missing: ${missing.join(", ")}`, missing.map((m) => `ollama pull ${m}`).join(" && "));
  else add("OK", "models pulled", want.join(", "));

  // GPU: load the smallest manifest model briefly, then read ollama ps.
  const probe = have("llama3.2:3b") ? "llama3.2:3b" : want.find(have);
  if (probe) {
    try {
      await http(`${OLLAMA}/api/generate`, { method: "POST", body: JSON.stringify({ model: probe, prompt: "", keep_alive: "2m" }) }, 60000);
      const ps = (await (await http(`${OLLAMA}/api/ps`)).json()).models ?? [];
      const m = ps.find((x) => x.name === probe || x.model === probe) ?? ps[0];
      const share = m && m.size ? Math.round((100 * (m.size_vram ?? 0)) / m.size) : 0;
      if (!m) add("WARN", "gpu in use", "could not read ollama ps", "");
      else if (share === 0) {
        add(ALLOW_CPU ? "WARN" : "FAIL", "gpu in use", `${probe}: 100% CPU (size_vram=0)`, "quit Ollama and start the Ollama tray app; if this machine has no GPU set DOCTOR_ALLOW_CPU=1");
      } else add("OK", "gpu in use", `${probe}: ${share}% on GPU (${(m.size_vram / 2 ** 30).toFixed(1)} GiB VRAM)`);
    } catch (e) {
      add("FAIL", "gpu in use", `probe load of ${probe} failed: ${e.message}`, "start the Ollama tray app; check `ollama ps`");
    }
  }
}

// ------------------------------------------------------------------ machine
{
  const free = os.freemem() / 2 ** 30;
  const total = os.totalmem() / 2 ** 30;
  const detail = `${free.toFixed(1)} GiB free of ${total.toFixed(1)} GiB`;
  if (free < 2) add("FAIL", "free RAM", detail, "close large apps (browsers, IDE windows) before running the models");
  else if (free < 6) add("WARN", "free RAM", `${detail} (benchmarks/soak need >= 6 GiB)`, "close large apps before `benchmarks/*`");
  else add("OK", "free RAM", detail);
}
for (const [name, port] of [
  ["API", process.env.API_PORT ?? "8000"],
  ["UI", process.env.UI_PORT ?? "5173"],
]) {
  const busy = await portInUse(Number(port));
  const fix = IS_WIN ? `Get-NetTCPConnection -LocalPort ${port} -State Listen | Select OwningProcess` : `lsof -iTCP:${port} -sTCP:LISTEN`;
  add(busy ? "WARN" : "OK", `port ${port} free`, busy ? `${name} port in use (npm run dev will refuse)` : `${name} port available`, busy ? fix : "");
}
for (const [name, url] of [
  ["internet: wikipedia", "https://en.wikipedia.org/w/api.php?action=query&meta=siteinfo&format=json"],
  ["internet: duckduckgo", "https://html.duckduckgo.com/html/?q=test"],
]) {
  try {
    const r = await http(url, { headers: { "User-Agent": "PersonalAIOS-doctor/0.3" } });
    add(r.ok ? "OK" : "WARN", name, `HTTP ${r.status}`, r.ok ? "" : "web_search falls back to the other provider; check proxy/firewall");
  } catch (e) {
    add("WARN", name, `unreachable (${e.name})`, "web tools will fail; offline mode: set POS_OFFLINE=1");
  }
}

// ------------------------------------------------------------------ report
const icon = { OK: "ok  ", WARN: "WARN", FAIL: "FAIL" };
console.log("\nPersonal AI OS - doctor\n");
for (const r of results) {
  console.log(`${icon[r.level]}  ${r.check.padEnd(22)} ${r.detail}`);
  if (r.level !== "OK" && r.fix) console.log(`${" ".repeat(28)}fix: ${r.fix}`);
}
const fails = results.filter((r) => r.level === "FAIL").length;
const warns = results.filter((r) => r.level === "WARN").length;
console.log(`\n${fails ? "DOCTOR FAILED" : "DOCTOR OK"} - ${fails} hard failure(s), ${warns} warning(s)`);
process.exit(fails ? 1 : 0);
