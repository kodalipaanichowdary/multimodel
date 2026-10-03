// npm run demo [-- --live] - guided, recorded walkthrough of the 9 demo scenes.
//
// default : deterministic stub model + offline test corpus (works without Ollama)
// --live  : real Ollama + web. Runs `npm run doctor` first and STOPS if it fails
//           (Ollama down, model on CPU, ...). This script never starts Ollama.
//
// Output: docs/demo/ (stub) or docs/demo/live/ (--live): NN-name.png per scene, demo.webm, DEMO.md.
// The scenes live in apps/workspace/demo/demo.spec.ts (Playwright, visible Edge window).
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { IS_WIN, ROOT, WEB_DIR, assertPortsFree, die, requireVenv, runInherit, tag } from "./lib.mjs";

const live = process.argv.includes("--live");
const NPX = IS_WIN ? "npx.cmd" : "npx";
const DEMO_PORTS = { API: 8003, UI: 5176 }; // same as apps/workspace/playwright.demo.config.ts

requireVenv();

if (live) {
  console.log(`${tag("demo")} --live: running doctor first`);
  const env = { ...process.env };
  delete env.DOCTOR_ALLOW_CPU; // the live demo needs the GPU
  const code = runInherit(process.execPath, [path.join(ROOT, "scripts", "doctor.mjs")], { env });
  if (code !== 0)
    die(
      "doctor failed, demo stopped. If Ollama is down or on CPU: quit it and start the Ollama tray app " +
        "(this script never starts Ollama), then rerun `npm run demo -- --live`.",
    );
}

// video recording needs Playwright's ffmpeg build (~1.3 MB, per-user cache, no admin): fetch once
const pwCache = process.env.PLAYWRIGHT_BROWSERS_PATH ??
  (IS_WIN ? path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright") : path.join(os.homedir(), ".cache", "ms-playwright"));
const hasFfmpeg = existsSync(pwCache) && readdirSync(pwCache).some((d) => d.startsWith("ffmpeg"));
if (!hasFfmpeg) {
  console.log(`${tag("demo")} one-time: npx playwright install ffmpeg (needed to record the video)`);
  if (runInherit(NPX, ["playwright", "install", "ffmpeg"], { cwd: WEB_DIR }) !== 0)
    die("could not download Playwright's ffmpeg; run `npx playwright install ffmpeg` in apps/workspace and retry");
}

await assertPortsFree([
  ["DEMO_API", DEMO_PORTS.API],
  ["DEMO_UI", DEMO_PORTS.UI],
]);

console.log(`${tag("demo")} mode: ${live ? "LIVE (Ollama + web)" : "stub (deterministic, offline corpus)"}`);
const code = runInherit(NPX, ["playwright", "test", "-c", "playwright.demo.config.ts"], {
  cwd: WEB_DIR,
  env: { ...process.env, DEMO_LIVE: live ? "1" : "0" },
});
console.log(
  code === 0
    ? `${tag("demo")} done: ${live ? "docs/demo/live/" : "docs/demo/"} (screenshots, demo.webm, DEMO.md)`
    : `${tag("demo")} the walkthrough exited ${code}; see the output above (partial results may be in docs/demo/)`,
);
process.exit(code);
