"""Regenerate packages/schemas/fixtures/mock_sequences.json from the mock script.

Deterministic: fixed task ids, ts = BASE + seq * STEP_MS, and execution.completed
duration_ms = last ts - first ts (what the live executor measures).

    python scripts/gen_fixtures.py
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app.mock_executor import script
from pos_schemas import make_event

OUT = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "schemas"
    / "fixtures"
    / "mock_sequences.json"
)
BASE = datetime(2026, 10, 2, 10, 0, 0, tzinfo=timezone.utc)
STEP_MS = 250
CASES = {
    "happy": ("Summarise MCP", "11111111-1111-1111-1111-111111111111"),
    "fail": ("please fail", "22222222-2222-2222-2222-222222222222"),
}


def build() -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for name, (prompt, tid) in CASES.items():
        steps = list(script(prompt, tid))
        events = []
        for seq, (etype, payload) in enumerate(steps):
            if etype == "execution.completed":
                payload["duration_ms"] = (len(steps) - 1) * STEP_MS
            ev = make_event(etype, task_id=tid, seq=seq, payload=payload)
            ev = ev.model_copy(
                update={"id": f"{name}-{seq}", "ts": BASE + timedelta(milliseconds=seq * STEP_MS)}
            )
            events.append(json.loads(ev.model_dump_json()))
        out[name] = events
    return out


if __name__ == "__main__":
    data = build()
    OUT.write_text(json.dumps(data, indent=1) + "\n", encoding="utf-8")
    print({k: len(v) for k, v in data.items()}, "->", OUT)
