# ADR 0002 — No Docker; local build only

Status: accepted (2026-10-02, user decision)

## Context
The Docker/Rancher install on this machine is not the user's and needs admin rights.
P1 shipped docker-compose (api, workspace/nginx, postgres, redis) that could never be run here.

## Decision
- Remove docker-compose.yml, both Dockerfiles, .dockerignore, the nginx conf and the compose smoke script.
- `scripts/build.ps1` is the single build entry point: installs from lock files, runs every gate,
  emits `out/web`, `out/wheels`, `out/BUILD_INFO.json`. It deploys nothing and starts no servers.
- Dev run stays native: uvicorn + Vite proxy (README "Run (local dev)").
- `/health` keeps reporting postgres/redis as `not_configured`; P1/P2 do not need them.

## Consequences
- G1.8 ("docker compose up") is waived and not carried into G2.
- P3 Memory (PostgreSQL/Redis in the stack list) will need a native install or an embedded
  alternative; decide in a P3 ADR. Not addressed now.
