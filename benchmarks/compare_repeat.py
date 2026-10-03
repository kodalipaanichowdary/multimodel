"""Diagnostic for the live parallel answer-quality problem: multi-part compare questions often
end "Could not verify". Runs each compare prompt N times (real Ollama + live web) and records
the outcome, the validator's rejection reasons, branches, sources and time.

Precondition (ENV RULES): doctor green, free RAM >= 6 GiB. Never starts Ollama.

    apps/api/.venv/Scripts/python benchmarks/compare_repeat.py [N]
Writes benchmarks/p3_compare_repeat.json.
"""

from __future__ import annotations

import json
import sys
import tempfile
import time
from dataclasses import replace
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))
sys.path.insert(0, str(ROOT / "benchmarks"))

from _sys import ram_gate, utf8_stdout  # noqa: E402

utf8_stdout()

from app.agent_runtime.grounding import HEDGE  # noqa: E402
from app.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from pos_schemas import parse_event  # noqa: E402

PROMPTS = [
    "Compare the populations of Hyderabad, Bangalore and Chennai",
    "Compare the heights of Mount Everest, K2 and Kangchenjunga",
]


def one(c: TestClient, prompt: str) -> dict:
    t0 = time.perf_counter()
    with c.websocket_connect("/ws") as ws:
        tid = c.post("/tasks", json={"prompt": prompt}).json()["task_id"]
        ev = []
        while True:
            e = parse_event(ws.receive_text())
            if e.task_id != tid:
                continue
            ev.append(e)
            if e.type.startswith("execution."):
                break
    answer = next((e.payload.content for e in ev if e.type == "artifact.created"), "")
    branches = sorted(
        {
            e.payload.agent_id
            for e in ev
            if e.type == "agent.started" and e.payload.agent_id.startswith("research")
        }
    )
    rejects = [
        e.payload.message
        for e in ev
        if e.type == "agent.thinking"
        and e.payload.agent_id == "validator"
        and e.payload.message.startswith("Rejected")
    ]
    return {
        "terminal": ev[-1].type,
        "outcome": "unverified" if HEDGE.search(answer) else "answered",
        "branches": branches,
        "fetches_ok": sum(
            1 for e in ev if e.type == "tool.completed" and e.payload.tool_id == "fetch_url"
        ),
        "fetches_failed": sum(
            1 for e in ev if e.type == "tool.failed" and e.payload.tool_id == "fetch_url"
        ),
        "validator_rejections": rejects,
        "seconds": round(time.perf_counter() - t0, 1),
        "answer": answer[:600],
    }


def main(n: int) -> int:
    free = ram_gate(force="--force" in sys.argv)
    if free is None:
        return 2
    tmp = Path(tempfile.mkdtemp(prefix="pos-compare-"))
    s = replace(
        Settings(),
        mock_executor=False,
        db_path=":memory:",
        memory_db_path=str(tmp / "memory.db"),
        audit_db_path="none",
        traces_dir="none",
        cors_origins=[],
    )
    out = {"when": time.strftime("%Y-%m-%d %H:%M:%S"), "free_ram_gib": free, "runs": {}}
    with TestClient(create_app(s)) as c:
        for prompt in PROMPTS:
            out["runs"][prompt] = []
            for i in range(n):
                r = one(c, prompt)
                out["runs"][prompt].append(r)
                print(
                    f"{prompt[:40]:40s} #{i + 1} {r['outcome']:10s} {r['seconds']:5.1f}s branches={len(r['branches'])} "
                    f"fetch ok/fail={r['fetches_ok']}/{r['fetches_failed']} | {(r['validator_rejections'] or ['-'])[-1][:150]}",
                    flush=True,
                )
    (ROOT / "benchmarks" / "p3_compare_repeat.json").write_text(
        json.dumps(out, indent=1), encoding="utf-8"
    )
    return 0


if __name__ == "__main__":
    nums = [a for a in sys.argv[1:] if a.isdigit()]
    raise SystemExit(main(int(nums[0]) if nums else 3))
