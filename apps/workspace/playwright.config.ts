import { defineConfig } from "@playwright/test";
import path from "node:path";

const API_PORT = 8001;
const UI_PORT = 5174;
const apiDir = path.resolve(process.cwd(), "../api");
const py = path.join(apiDir, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${UI_PORT}`,
    channel: process.env.PW_CHANNEL ?? "msedge",
    viewport: { width: 1600, height: 900 },
    headless: process.env.HEADED ? false : true,
  },
  webServer: [
    {
      command: `"${py}" -m uvicorn app.main:app --port ${API_PORT}`,
      cwd: apiDir,
      url: `http://127.0.0.1:${API_PORT}/health`,
      env: { MOCK_STEP_DELAY_S: "0.25" },
      reuseExistingServer: false,
    },
    {
      command: `npx vite --port ${UI_PORT} --strictPort`,
      url: `http://localhost:${UI_PORT}`,
      env: { API_TARGET: `http://127.0.0.1:${API_PORT}` },
      reuseExistingServer: false,
    },
  ],
});
