"""P1 patch: agents added via POST /agents and flagged `selected` get one mock step."""

import pytest
from pos_schemas import parse_event

from app.mock_executor import ExtraAgent, script

CRITIC = {
    "id": "critic",
    "name": "Critic",
    "description": "Critiques drafts",
    "capabilities": ["critique"],
    "tools": [],
    "model_profile": {"model": "llama3.2:3b"},
    "permissions": ["fs.write"],
}


def run_task(client, body) -> list:
    with client.websocket_connect("/ws") as ws:
        r = client.post("/tasks", json=body)
        assert r.status_code == 202, r.text
        events = []
        while True:
            ev = parse_event(ws.receive_text())
            events.append(ev)
            if ev.type.startswith("execution."):
                return events


def test_create_then_duplicate_then_invalid(client):
    assert client.post("/agents", json=CRITIC).status_code == 201
    assert client.get("/agents/critic").json()["permissions"] == ["fs.write"]
    dup = client.post("/agents", json=CRITIC)
    assert dup.status_code == 409 and "already exists" in dup.json()["detail"]
    bad = client.post("/agents", json={**CRITIC, "id": "x y", "capabilities": []})
    assert bad.status_code == 422
    locs = {tuple(e["loc"]) for e in bad.json()["detail"]}
    assert ("body", "id") in locs and ("body", "capabilities") in locs
    assert len(client.get("/agents").json()) == 7


def test_selected_agent_gets_one_scripted_step(client):
    client.post("/agents", json=CRITIC)
    events = run_task(client, {"prompt": "review this", "selected": ["critic"]})
    mine = [e for e in events if getattr(e.payload, "agent_id", None) == "critic"]
    assert [e.type for e in mine] == ["agent.started", "agent.thinking", "agent.completed"]
    assert mine[0].payload.parent_id == "orchestrator"
    plan = next(e for e in events if e.type == "task.planned")
    assert [s.agent_id for s in plan.payload.steps] == ["research", "writer", "critic", "validator"]
    assert len(events) == 22 + 3
    assert [e.seq for e in events] == list(range(len(events)))
    art = next(e for e in events if e.type == "artifact.created")
    assert "**critic**" in art.payload.content


def test_selected_builtins_and_duplicates_are_noops():
    plain = [t for t, _ in script("x", "t" * 36)]
    dup = [ExtraAgent("research", "Research"), ExtraAgent("orchestrator", "O")]
    assert [t for t, _ in script("x", "t" * 36, dup)] == plain
    twice = [ExtraAgent("critic", "Critic")] * 2
    assert len(list(script("x", "t" * 36, twice))) == len(plain) + 3


def test_selected_unknown_agent_rejected(client):
    r = client.post("/tasks", json={"prompt": "x", "selected": ["ghost"]})
    assert r.status_code == 422 and "ghost" in r.json()["detail"]


@pytest.mark.parametrize(
    "body", [{"prompt": "x", "selected": "critic"}, {"prompt": "x", "other": 1}]
)
def test_task_request_shape_enforced(client, body):
    assert client.post("/tasks", json=body).status_code == 422


def test_selected_on_fail_path_never_runs(client):
    client.post("/agents", json=CRITIC)
    events = run_task(client, {"prompt": "please fail", "selected": ["critic"]})
    assert events[-1].type == "execution.failed"
    assert not any(e.type == "agent.started" and e.payload.agent_id == "critic" for e in events)
