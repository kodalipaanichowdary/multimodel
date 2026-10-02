// npm run dev — API (uvicorn --reload) + UI (vite) in one terminal. Ctrl+C stops both.
import { API_DIR, VENV_PY, VITE, WEB_DIR, assertPortsFree, loadEnv, requireVenv, startService, supervise } from "./lib.mjs";

const env = loadEnv();
const API_PORT = env.API_PORT ?? "8000";
const UI_PORT = env.UI_PORT ?? "5173";

requireVenv();
await assertPortsFree([
  ["API", API_PORT],
  ["UI", UI_PORT],
]);

const childEnv = { ...env, API_TARGET: `http://127.0.0.1:${API_PORT}`, PYTHONUNBUFFERED: "1" };
const api = startService(
  "api",
  VENV_PY,
  ["-m", "uvicorn", "app.main:app", "--reload", "--host", "127.0.0.1", "--port", API_PORT],
  { cwd: API_DIR, env: childEnv },
);
const ui = startService("ui", process.execPath, [VITE, "--port", UI_PORT, "--strictPort", "--host", "127.0.0.1"], {
  cwd: WEB_DIR,
  env: childEnv,
});

console.log(`dev: API http://127.0.0.1:${API_PORT}  UI http://localhost:${UI_PORT}   (Ctrl+C stops both)`);
supervise([
  { name: "api", child: api },
  { name: "ui", child: ui },
]);
