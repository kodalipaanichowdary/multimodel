# ADR 0002 — Native toolchain, one-command local run

Status: accepted (2026-10-02, user decision; supersedes the original container stack)

## Context
The machine is not the user's: no admin rights, no container runtime. Deployment is out of scope.

## Decision
- The project runs natively: Python venv (`apps/api/.venv`) + npm workspaces.
- Four entry points, all plain Node scripts in `scripts/` (built-ins only, Windows/macOS/Linux):
  `npm run setup`, `npm run dev`, `npm run check`, `npm run build` (+ `npm run preview`).
- `dev` supervises uvicorn and Vite as child process trees and stops both on Ctrl+C / SIGTERM.
- No external services. `/health` reports `{status, version, executor}` only.
- Persistence, when needed (P2 event log), is a local SQLite file behind a repository interface.

## Consequences
- G1.8 is redefined as "one-command local run + production UI build".
- Anything that needs a server-grade datastore must justify itself in a later ADR.
