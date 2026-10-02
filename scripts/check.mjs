// npm run check — every lint/test suite, in order; stops at the first failure.
import path from "node:path";
import { API_DIR, NPM, ROOT, VENV_BIN, VENV_PY, WEB_DIR, IS_WIN, requireVenv, runInherit, tag } from "./lib.mjs";

requireVenv();
const RUFF = path.join(VENV_BIN, IS_WIN ? "ruff.exe" : "ruff");
const NPX = IS_WIN ? "npx.cmd" : "npx";
const PY_SRC = [".", "../../packages/schemas/python"];

const steps = [
  ["ruff check", RUFF, ["check", ...PY_SRC], API_DIR],
  ["ruff format --check", RUFF, ["format", "--check", ...PY_SRC], API_DIR],
  ["pytest", VENV_PY, ["-m", "pytest", "-q", "-p", "no:warnings"], API_DIR],
  ["tsc", NPM, ["run", "typecheck", "--silent"], ROOT],
  ["eslint --max-warnings 0", NPM, ["run", "lint", "--silent"], ROOT],
  ["vitest", NPM, ["test", "--silent"], ROOT],
  ["playwright", NPX, ["playwright", "test"], WEB_DIR],
];

const results = [];
let failed = null;
for (const [name, cmd, args, cwd] of steps) {
  console.log(`\n${tag("check")} ▶ ${name}`);
  const t0 = Date.now();
  const code = runInherit(cmd, args, { cwd });
  results.push({ step: name, status: code === 0 ? "ok" : `FAIL (exit ${code})`, seconds: ((Date.now() - t0) / 1000).toFixed(1) });
  if (code !== 0) {
    failed = name;
    break;
  }
}
for (const [name] of steps.slice(results.length)) results.push({ step: name, status: "skipped", seconds: "-" });

console.log("\nstep                       status            seconds");
console.log("-------------------------  ----------------  -------");
for (const r of results) console.log(`${r.step.padEnd(25)}  ${r.status.padEnd(16)}  ${r.seconds.padStart(7)}`);
console.log(failed ? `\nCHECK FAILED at: ${failed}` : "\nCHECK OK — all suites green");
process.exit(failed ? 1 : 0);
