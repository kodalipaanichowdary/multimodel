import { defineConfig } from "@playwright/test";
import path from "node:path";
import { runDir } from "./e2e/run-dir";

// `npm run demo` (scripts/demo.mjs) only; not part of `npm run check` (testDir "demo").
// DEMO_LIVE=1 -> real Ollama + web; otherwise the p2-style stub model + offline corpus.
const LIVE = process.env.DEMO_LIVE === "1";
const API = 8003;
const UI = 5176;
const apiDir = path.resolve(process.cwd(), "../api");
const py = path.join(apiDir, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
const tmp = runDir(); // fresh per run (never reuse an earlier run's databases)

const stub = {
  LLM_PROVIDER: "stub",
  STUB_DELAY_S: "1.0", // slowed down so the strip is watchable
  STUB_TOOL_DELAY_S: "0.8",
  SEARCH_PROVIDER: "stub",
  FETCH_PROVIDER: "stub",
};

export default defineConfig({
  testDir: "demo",
  timeout: 20 * 60_000,
  workers: 1,
  reporter: [["list"]],
  outputDir: path.join(tmp, "pw-output"),
  use: {
    channel: process.env.PW_CHANNEL ?? "msedge",
    baseURL: `http://localhost:${UI}`,
    headless: false,
    viewport: { width: 1440, height: 900 },
    video: { mode: "on", size: { width: 1440, height: 900 } },
    launchOptions: { slowMo: 120 },
  },
  metadata: { live: LIVE, tmp },
  webServer: [
    {
      command: `"${py}" -m uvicorn app.main:app --port ${API}`,
      cwd: apiDir,
      url: `http://127.0.0.1:${API}/health`,
      env: {
        ...(LIVE ? {} : stub),
        FS_WRITE_ROOT: path.join(tmp, "artifacts"),
        POS_DB_PATH: path.join(tmp, "pos.db"),
        POS_MEMORY_DB: path.join(tmp, "memory.db"),
        POS_AUDIT_DB: path.join(tmp, "audit.db"),
        POS_TRACES_DIR: path.join(tmp, "traces"),
        APPROVAL_TIMEOUT_S: "120",
        UI_PORT: String(UI),
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `npx vite --port ${UI} --strictPort`,
      url: `http://localhost:${UI}`,
      env: { API_TARGET: `http://127.0.0.1:${API}`, UI_PORT: String(UI) },
      reuseExistingServer: false,
    },
  ],
});
