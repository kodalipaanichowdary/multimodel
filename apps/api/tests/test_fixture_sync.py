"""mock_sequences.json feeds the UI projection tests; it must match the real script."""

import json

from app.mock_executor import script

from .conftest import REPO

FIXTURE = REPO / "packages" / "schemas" / "fixtures" / "mock_sequences.json"


def test_mock_sequence_fixture_in_sync():
    data = json.loads(FIXTURE.read_text())
    for name, prompt in [("happy", "Summarise MCP"), ("fail", "please fail")]:
        tid = data[name][0]["task_id"]
        expected = [{"type": t, "payload": p} for t, p in script(prompt, tid)]
        actual = [{"type": e["type"], "payload": e["payload"]} for e in data[name]]
        assert actual == expected, f"regenerate {FIXTURE.name} ({name})"
