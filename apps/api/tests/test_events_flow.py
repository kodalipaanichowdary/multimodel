import asyncio

import pytest
from pos_schemas import EVENT_TYPES, make_event, parse_event

from app.bus import EventBus
from app.mock_executor import MockExecutor, script

TERMINAL = {"execution.completed", "execution.failed"}


def collect(ws) -> list:
    events = []
    while True:
        ev = parse_event(ws.receive_text())  # Pydantic-validates the wire format
        events.append(ev)
        if ev.type in TERMINAL:
            return events


def test_script_happy_path_is_ordered():
    types = [t for t, _ in script("write a report", "t" * 36)]
    assert types[0] == "task.created"
    assert types[-1] == "execution.completed"
    assert types.index("task.planned") < types.index("tool.started")
    assert types.index("approval.requested") < types.index("approval.granted")
    # fs_write tool only after approval
    assert types.index("approval.granted") < len(types) - 1 - types[::-1].index("tool.started")
    assert "artifact.created" in types


def test_script_uses_all_but_failure_types():
    happy = {t for t, _ in script("ok", "t" * 36)}
    sad = {t for t, _ in script("please fail", "t" * 36)}
    assert happy | sad == set(EVENT_TYPES)
    assert "execution.failed" in sad and "tool.failed" in sad
    assert "execution.completed" not in sad


def test_ws_streams_valid_sequence(client):
    with client.websocket_connect("/ws") as ws:
        r = client.post("/tasks", json={"prompt": "Summarise MCP"})
        assert r.status_code == 202
        task_id = r.json()["task_id"]
        events = collect(ws)
    assert all(e.task_id == task_id for e in events)
    assert [e.seq for e in events] == list(range(len(events)))
    assert events[-1].type == "execution.completed"
    art = [e for e in events if e.type == "artifact.created"]
    assert events[-1].payload.artifact_ids == [art[0].payload.artifact_id]


def test_ws_failure_path(client):
    with client.websocket_connect("/ws") as ws:
        client.post("/tasks", json={"prompt": "make it fail"})
        events = collect(ws)
    assert [e.type for e in events][-2:] == ["tool.failed", "execution.failed"]


def test_ws_fanout_to_multiple_clients(client):
    with client.websocket_connect("/ws") as a, client.websocket_connect("/ws") as b:
        client.post("/tasks", json={"prompt": "x"})
        ea, eb = collect(a), collect(b)
    assert [e.id for e in ea] == [e.id for e in eb]


def test_task_rejects_empty_prompt(client):
    assert client.post("/tasks", json={"prompt": ""}).status_code == 422


@pytest.mark.asyncio
async def test_concurrent_tasks_keep_per_task_seq():
    bus = EventBus()
    q = bus.subscribe()
    ex = MockExecutor(bus, step_delay_s=0.001)
    ids = {ex.submit("a"), ex.submit("b"), ex.submit("c")}
    done: set[str] = set()
    seqs: dict[str, list[int]] = {i: [] for i in ids}
    while done != ids:
        ev = await asyncio.wait_for(q.get(), 5)
        seqs[ev.task_id].append(ev.seq)
        if ev.type in TERMINAL:
            done.add(ev.task_id)
    for s in seqs.values():
        assert s == list(range(len(s)))


def test_bus_drops_oldest_for_slow_subscriber():
    bus = EventBus(queue_size=2)
    q = bus.subscribe()
    for i, (t, p) in enumerate(script("x", "t" * 36)):
        if i == 3:
            break
        bus.publish(make_event(t, task_id="t", seq=i, payload=p))
    assert q.qsize() == 2 and q.get_nowait().seq == 1
