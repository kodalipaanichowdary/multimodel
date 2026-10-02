"""Real runtime end to end (LangGraph pipeline + MCP tools + approvals), offline:
stub model (answers only from the prompt's SOURCES) + stub search/fetch corpus."""

import json
from dataclasses import replace

from fastapi.testclient import TestClient
from pos_schemas import parse_event

from app.main import create_app
from app.models.base import LLMResult, Metrics

TERMINAL = ("execution.completed", "execution.failed")


def run(client, prompt, *, on_event=None):
    """Submit over HTTP, follow over WS until the run ends. on_event may act (approve/kill)."""
    with client.websocket_connect("/ws") as ws:
        r = client.post("/tasks", json={"prompt": prompt})
        assert r.status_code == 202, r.text
        tid = r.json()["task_id"]
        events = []
        while True:
            ev = parse_event(ws.receive_text())
            if ev.task_id != tid:
                continue
            events.append(ev)
            if on_event:
                on_event(ev, client, tid)
            if ev.type in TERMINAL:
                return tid, events


def types(events):
    return [e.type for e in events]


def of(events, t):
    return [e for e in events if e.type == t]


def test_happy_path_is_real_and_grounded(real_client):
    assert real_client.get("/health").json()["executor"] == "real"
    tid, ev = run(real_client, "Who chairs the Zephyr Harbor Authority?")
    t = types(ev)
    assert t[0] == "task.created" and t[-1] == "execution.completed"
    plan = of(ev, "task.planned")[0].payload
    assert [s.agent_id for s in plan.steps] == ["research", "writer", "validator"]
    tools = [(e.payload.tool_id, e.type) for e in ev if e.type.startswith("tool.")]
    assert ("web_search", "tool.completed") in tools
    assert tools.count(("fetch_url", "tool.completed")) == 2
    metrics = of(ev, "model.metrics")
    assert {m.payload.agent_id for m in metrics} == {"orchestrator", "research", "writer"}
    assert all(m.payload.model == "stub" and m.payload.attempt == 1 for m in metrics)
    for a in ("research", "writer", "validator"):
        assert any(e.type == "agent.started" and e.payload.agent_id == a for e in ev)
    validator_done = next(e for e in of(ev, "agent.completed") if e.payload.agent_id == "validator")
    assert validator_done.payload.summary.startswith("grounded")
    art = of(ev, "artifact.created")[0].payload.content
    assert "Ada Quill" in art and "[1]" in art
    assert "https://example.org/zephyr-harbor" in art  # cites a fetched URL
    # persisted: listed and replayable
    tasks = real_client.get("/tasks").json()
    assert tasks[0]["task_id"] == tid and tasks[0]["status"] == "completed"
    stored = real_client.get(f"/tasks/{tid}/events").json()
    assert [s["id"] for s in stored] == [e.id for e in ev]


def test_empty_search_says_could_not_verify(real_client):
    _, ev = run(real_client, "zzz-no-results: who chairs it?")
    assert of(ev, "tool.completed")[0].payload.result_preview == "0 results"
    assert not [e for e in ev if e.type == "tool.started" and e.payload.tool_id == "fetch_url"]
    art = of(ev, "artifact.created")[0].payload.content
    assert art.startswith("**Could not verify**") and "no usable sources" in art
    assert types(ev)[-1] == "execution.completed"


class Scripted:
    """Model that returns fixed JSON per schema title (for grounding-failure paths)."""

    name = "scripted"

    def __init__(self, drafts):
        self.drafts = list(drafts)
        self.calls = []

    async def generate(self, profile, messages, schema):
        title = schema.get("title")
        self.calls.append(title)
        out = {
            "Plan": {
                "search_query": "zephyr harbor chair",
                "steps": [{"agent_id": "research", "goal": "g"}],
            },
            "ResearchResult": {
                "summary": "s",
                "sources": [{"url": "https://example.org/zephyr-harbor"}],
                "confidence": 0.5,
            },
        }.get(title)
        text = json.dumps(out) if out else self.drafts.pop(0)
        return LLMResult(text, Metrics("scripted", 1, 1.0, 1, 1, 1))


def test_ungrounded_answer_is_revised_once_then_falls_back(real_client):
    ungrounded = json.dumps(
        {
            "answer": "The authority is chaired by Bob Marsh [1].",
            "citations": ["https://example.org/zephyr-harbor"],
        }
    )
    llm = Scripted([ungrounded, ungrounded])
    real_client.app.state.executor._deps.llm = llm
    _, ev = run(real_client, "Who chairs the Zephyr Harbor Authority?")
    writer_starts = [e for e in ev if e.type == "agent.started" and e.payload.agent_id == "writer"]
    assert len(writer_starts) == 2  # draft + one revision
    assert llm.calls.count("Draft") == 2
    issues = [
        e.payload.summary for e in of(ev, "agent.completed") if e.payload.agent_id == "validator"
    ]
    assert all("grounding issue" in s for s in issues)
    art = of(ev, "artifact.created")[0].payload.content
    assert art.startswith("**Could not verify**") and "Bob Marsh" not in art


def test_revision_that_fixes_grounding_passes(real_client):
    bad = json.dumps(
        {
            "answer": "It is chaired by Bob Marsh [1].",
            "citations": ["https://example.org/zephyr-harbor"],
        }
    )
    good = json.dumps(
        {
            "answer": "The Zephyr Harbor Authority is chaired by Ada Quill [1].",
            "citations": ["https://example.org/zephyr-harbor"],
        }
    )
    real_client.app.state.executor._deps.llm = Scripted([bad, good])
    _, ev = run(real_client, "Who chairs the Zephyr Harbor Authority?")
    art = of(ev, "artifact.created")[0].payload.content
    assert "Ada Quill" in art and "Bob" not in art and "**Sources**" in art


def test_invalid_model_output_heals_with_metrics_per_attempt(real_client):
    good = json.dumps(
        {
            "answer": "The Zephyr Harbor Authority is chaired by Ada Quill [1].",
            "citations": ["https://example.org/zephyr-harbor"],
        }
    )
    llm = Scripted(['{"answer": ""}', good])
    real_client.app.state.executor._deps.llm = llm
    _, ev = run(real_client, "Who chairs the Zephyr Harbor Authority?")
    w = [e.payload for e in of(ev, "model.metrics") if e.payload.agent_id == "writer"]
    assert [m.attempt for m in w] == [1, 2]
    assert any(e.type == "agent.thinking" and "retrying once" in e.payload.message for e in ev)
    assert "Ada Quill" in of(ev, "artifact.created")[0].payload.content


def _decide(decision):
    def act(ev, client, _tid):
        if ev.type == "approval.requested":
            r = client.post(f"/approvals/{ev.payload.approval_id}", json={"decision": decision})
            assert r.status_code == 200, r.text

    return act


def test_fs_write_needs_approval_allow(real_client, stub_tools):
    tid, ev = run(
        real_client,
        "Who chairs the Zephyr Harbor Authority? Save it to a file.",
        on_event=_decide("allow"),
    )
    t = types(ev)
    i_req, i_ok = t.index("approval.requested"), t.index("approval.granted")
    started = [
        i for i, e in enumerate(ev) if e.type == "tool.started" and e.payload.tool_id == "fs_write"
    ]
    assert i_req < i_ok < started[0]  # tool only runs after the user allowed it
    assert of(ev, "approval.requested")[0].payload.agent_id == "writer"
    saved = stub_tools / f"{tid[:8]}-answer.md"
    assert saved.exists() and "Ada Quill" in saved.read_text(encoding="utf-8")
    assert t[-1] == "execution.completed"


def test_fs_write_deny_aborts_step_cleanly(real_client, stub_tools):
    tid, ev = run(
        real_client,
        "Who chairs the Zephyr Harbor Authority? Save it to a file.",
        on_event=_decide("deny"),
    )
    assert of(ev, "approval.denied")[0].payload.by == "user"
    assert not [e for e in ev if e.type.startswith("tool.") and e.payload.tool_id == "fs_write"]
    assert not (stub_tools / f"{tid[:8]}-answer.md").exists()
    assert any(e.type == "agent.completed" and "approval denied" in e.payload.summary for e in ev)
    assert types(ev)[-1] == "execution.completed"  # run itself finishes; answer still delivered
    assert "Ada Quill" in of(ev, "artifact.created")[0].payload.content


def test_approval_timeout_denies(real_settings):
    with TestClient(create_app(replace(real_settings, approval_timeout_s=0.3))) as c:
        _, ev = run(c, "Who chairs the Zephyr Harbor Authority? Save it to a file.")
    d = of(ev, "approval.denied")[0].payload
    assert (d.by == "timeout" and "0s" in d.reason) or "no decision" in d.reason
    assert types(ev)[-1] == "execution.completed"


def test_unknown_or_stale_approval_is_404(real_client):
    assert real_client.post("/approvals/nope", json={"decision": "allow"}).status_code == 404
    assert real_client.post("/approvals/nope", json={"decision": "maybe"}).status_code == 422


def test_kill_mid_run_marks_error(real_settings):
    with TestClient(create_app(replace(real_settings, stub_delay_s=0.3))) as c:

        def kill_on_research(ev, client, tid):
            if ev.type == "agent.started" and ev.payload.agent_id == "research":
                assert client.post(f"/tasks/{tid}/kill").status_code == 202

        tid, ev = run(c, "Who chairs the Zephyr Harbor Authority?", on_event=kill_on_research)
        failed = ev[-1]
        assert failed.type == "execution.failed" and failed.payload.error == "killed by user"
        assert failed.payload.agent_id == "research"
        assert not of(ev, "artifact.created")
        # every started tool call was closed (completed or failed), none left dangling
        started = {e.payload.call_id for e in ev if e.type == "tool.started"}
        closed = {e.payload.call_id for e in ev if e.type in ("tool.completed", "tool.failed")}
        assert started <= closed
        assert c.post(f"/tasks/{tid}/kill").status_code == 409  # already finished


def test_selected_agents_rejected_by_real_executor(real_client):
    real_client.post(
        "/agents",
        json={
            "id": "critic",
            "name": "Critic",
            "description": "d",
            "capabilities": ["c"],
            "model_profile": {"model": "m"},
        },
    )
    r = real_client.post("/tasks", json={"prompt": "x", "selected": ["critic"]})
    assert r.status_code == 422 and "fixed P2 pipeline" in r.json()["detail"]


def test_model_unreachable_is_a_handled_failure(real_settings):
    s = replace(real_settings, llm_provider="ollama", ollama_url="http://127.0.0.1:9")
    with TestClient(create_app(s)) as c:
        _, ev = run(c, "anything")
        assert ev[-1].type == "execution.failed" and ev[-1].payload.error.startswith(
            "model unavailable"
        )
        assert c.app.state.executor.unhandled == 0


def test_twenty_consecutive_runs_zero_unhandled(real_client):
    outcomes = []
    for i in range(20):
        prompt = [
            "Who chairs the Zephyr Harbor Authority?",
            "zzz-no-results q",
            "When was Zephyr harbor founded?",
        ][i % 3]
        _, ev = run(real_client, f"{prompt} #{i}")
        outcomes.append(ev[-1].type)
    assert outcomes == ["execution.completed"] * 20
    assert real_client.app.state.executor.unhandled == 0
