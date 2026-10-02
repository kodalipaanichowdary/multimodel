#!/usr/bin/env bash
# G1 compose smoke: bring stack up, wait for health, hit every surface.
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose up -d --build --wait
docker compose ps

echo "--- /api/health (via nginx)"
curl -fsS http://localhost:8080/api/health; echo
echo "--- /api/agents count"
curl -fsS http://localhost:8080/api/agents | python -c "import json,sys; a=json.load(sys.stdin); print(len(a), [x['id'] for x in a])"
echo "--- POST /api/tasks + WS via nginx"
python - <<'EOF'
import asyncio, json, urllib.request
import websockets  # pip install websockets

async def main():
    async with websockets.connect("ws://localhost:8080/ws") as ws:
        req = urllib.request.Request("http://localhost:8080/api/tasks", data=b'{"prompt":"compose smoke"}',
                                     headers={"content-type": "application/json"})
        print("task", json.load(urllib.request.urlopen(req)))
        while True:
            ev = json.loads(await asyncio.wait_for(ws.recv(), 10))
            print(ev["seq"], ev["type"])
            if ev["type"].startswith("execution."):
                break

asyncio.run(main())
EOF
echo "SMOKE OK"
