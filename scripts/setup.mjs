// npm run setup — Python venv + editable installs + npm workspaces. No admin, no global installs.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { IS_WIN, NPM, ROOT, VENV, VENV_PY, die, runInherit } from "./lib.mjs";

const MIN = [3, 10];

/** First Python >= 3.10 found on PATH: python3, python, then the Windows `py -3` launcher. */
function findPython() {
  const candidates = [["python3"], ["python"], ...(IS_WIN ? [["py", "-3"]] : [])];
  for (const [cmd, ...pre] of candidates) {
    const r = spawnSync(cmd, [...pre, "-c", "import sys;print('%d.%d'%sys.version_info[:2])"], { encoding: "utf8" });
    if (r.status !== 0 || !r.stdout) continue;
    const [maj, min] = r.stdout.trim().split(".").map(Number);
    if (maj > MIN[0] || (maj === MIN[0] && min >= MIN[1])) return { cmd, pre, version: r.stdout.trim() };
  }
  return null;
}

const node = Number(process.versions.node.split(".")[0]);
if (node < 18) die(`Node ${process.versions.node} is too old (need >= 18)`);

if (!existsSync(VENV_PY)) {
  const py = findPython();
  if (!py) die("No Python >= 3.10 on PATH (tried python3, python" + (IS_WIN ? ", py -3" : "") + ")");
  console.log(`▶ creating venv with ${py.cmd} ${py.pre.join(" ")} (Python ${py.version}) -> ${VENV}`);
  if (runInherit(py.cmd, [...py.pre, "-m", "venv", VENV]) !== 0) die("venv creation failed");
} else {
  console.log(`▶ venv exists: ${VENV}`);
}

console.log("▶ pip install -e packages/schemas/python -e apps/api[dev]");
const pip = [
  "-m",
  "pip",
  "install",
  "--disable-pip-version-check",
  "-q",
  "-e",
  "packages/schemas/python",
  "-e",
  "apps/api[dev]",
];
if (runInherit(VENV_PY, pip, { cwd: ROOT }) !== 0) die("pip install failed");

console.log("▶ npm install (workspaces, from package-lock.json)");
if (runInherit(NPM, ["install", "--no-audit", "--no-fund"], { cwd: ROOT }) !== 0) die("npm install failed");

console.log(`
✓ setup complete

  npm run dev      API :8000 + UI :5173 (Ctrl+C stops both)
  npm run check    all lint + test suites
  npm run build    production UI -> apps/workspace/dist

Playwright uses your installed Edge (default) or Chrome (set PW_CHANNEL=chrome);
no browser download is needed. Optional overrides: copy .env.example to .env.`);
