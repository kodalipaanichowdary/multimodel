// npm run preview — production UI build, served by `vite preview`, talking to the API.
import {
  API_DIR,
  NPM,
  ROOT,
  VENV_PY,
  VITE,
  WEB_DIR,
  assertPortsFree,
  die,
  loadEnv,
  requireVenv,
  runInherit,
  startService,
  supervise,
} from "./lib.mjs";

const env = loadEnv();
const API_PORT = env.API_PORT ?? "8000";
const PREVIEW_PORT = env.PREVIEW_PORT ?? "4173";

requireVenv();
await assertPortsFree([
  ["API", API_PORT],
  ["PREVIEW", PREVIEW_PORT],
]);
if (runInherit(NPM, ["run", "build"], { cwd: ROOT }) !== 0) die("build failed");

const childEnv = {
  ...env,
  API_TARGET: `http://127.0.0.1:${API_PORT}`,
  UI_PORT: PREVIEW_PORT, // API's CORS default follows the UI port
  PYTHONUNBUFFERED: "1",
};
const api = startService("api", VENV_PY, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", API_PORT], {
  cwd: API_DIR,
  env: childEnv,
});
const ui = startService("ui", process.execPath, [VITE, "preview", "--port", PREVIEW_PORT, "--strictPort", "--host", "127.0.0.1"], {
  cwd: WEB_DIR,
  env: childEnv,
});
console.log(`preview: production UI http://localhost:${PREVIEW_PORT}  API http://127.0.0.1:${API_PORT}   (Ctrl+C stops both)`);
supervise([
  { name: "api", child: api },
  { name: "ui", child: ui },
]);
