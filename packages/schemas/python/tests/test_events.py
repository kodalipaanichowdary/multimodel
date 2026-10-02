import json
from pathlib import Path

import pytest
from pos_schemas import EVENT_TYPES, make_event, parse_event
from pydantic import ValidationError

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures"
VALID = json.loads((FIXTURES / "events.valid.json").read_text())
INVALID = json.loads((FIXTURES / "events.invalid.json").read_text())


def test_fixtures_cover_every_type():
    assert sorted({e["type"] for e in VALID}) == sorted(EVENT_TYPES)
    assert len(EVENT_TYPES) == 15


@pytest.mark.parametrize("raw", VALID, ids=[e["id"] for e in VALID])
def test_accepts_valid(raw):
    ev = parse_event(raw)
    assert ev.type == raw["type"]
    # roundtrip through JSON stays valid (what the WS actually sends)
    assert parse_event(ev.model_dump_json()).model_dump() == ev.model_dump()


@pytest.mark.parametrize("case", INVALID, ids=[c["why"] for c in INVALID])
def test_rejects_invalid(case):
    with pytest.raises(ValidationError):
        parse_event(case["event"])


def test_make_event_validates_payload():
    ev = make_event("agent.thinking", task_id="t", seq=0, payload={"agent_id": "a", "message": "m"})
    assert ev.id and ev.ts.tzinfo is not None
    with pytest.raises(ValidationError):
        make_event("agent.thinking", task_id="t", seq=0, payload={"agent_id": "a"})
    with pytest.raises(ValueError):
        make_event("nope", task_id="t", seq=0, payload={})


def test_serialized_ts_is_iso_utc():
    ev = make_event("task.created", task_id="t", seq=0, payload={"prompt": "x"})
    ts = json.loads(ev.model_dump_json())["ts"]
    assert ts.endswith("Z") or ts.endswith("+00:00")
