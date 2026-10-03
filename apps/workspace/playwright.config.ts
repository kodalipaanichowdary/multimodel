import { defineConfig } from "@playwright/test";
import os from "node:os";
import path from "node:path";

// p1: P1 contract server (scripted mock executor, nothing persisted) -> g1*.spec.ts
// p2: real runtime (LangGraph pipeline, MCP tools, approvals, SQLite) with the deterministic
//     stub model + offline tool corpus -> g2*.spec.ts
const P1 = { api: 8001, ui: 5174 };
const P2 = { api: 8002, ui: 5175 };
const apiDir = path.resolve(process.cwd(), "../api");
const py = path.join(apiDir, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
const p2Tmp = path.join(os.tmpdir(), `pos-e2e-${process.pid}`);

const ui = (port: number, api: number) => ({
  command: `npx vite --port ${port} --strictPort`,
  url: `http://localhost:${port}`,
  env: { API_TARGET: `http://127.0.0.1:${api}`, UI_PORT: String(port) },
  reuseExistingServer: false,
});

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  workers: 1,
  reporter: [["list"]],
  use: {
    channel: process.env.PW_CHANNEL ?? "msedge",
    viewport: { width: 1600, height: 900 },
    headless: process.env.HEADED ? false : true,
  },
  projects: [
    { name: "p1", testMatch: /g1.*\.spec\.ts/, use: { baseURL: `http://localhost:${P1.ui}` } },
    { name: "p2", testMatch: /g2.*\.spec\.ts/, use: { baseURL: `http://localhost:${P2.ui}` } },
  ],
  webServer: [
    {
      command: `"${py}" -m uvicorn app.main:app --port ${P1.api}`,
      cwd: apiDir,
      url: `http://127.0.0.1:${P1.api}/health`,
      env: { MOCK_EXECUTOR: "1", MOCK_STEP_DELAY_S: "0.25", POS_DB_PATH: "none", UI_PORT: String(P1.ui) },
      reuseExistingServer: false,
    },
    ui(P1.ui, P1.api),
    {
      command: `"${py}" -m uvicorn app.main:app --port ${P2.api}`,
      cwd: apiDir,
      url: `http://127.0.0.1:${P2.api}/health`,
      env: {
        LLM_PROVIDER: "stub",
        STUB_DELAY_S: "0.6",
        SEARCH_PROVIDER: "stub",
        FETCH_PROVIDER: "stub",
        FS_WRITE_ROOT: path.join(p2Tmp, "artifacts"),
        POS_DB_PATH: path.join(p2Tmp, "pos.db"),
        APPROVAL_TIMEOUT_S: "60",
        UI_PORT: String(P2.ui),
      },
      reuseExistingServer: false,
    },
    ui(P2.ui, P2.api),
  ],
});
