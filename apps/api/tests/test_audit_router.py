"""G3.10 audit log + OTel traces, G3.11 model router + offline mode."""

import json
import sqlite3
import sys
from dataclasses import replace

import pytest
from app.audit import AuditLog
from app.main import create_app
from app.models.base import LLMError, Message
from app.models.cloud import CloudClient
from app.models.router import ModelRouter
from app.models.stub import StubClient
from app.tracing import LocalFileSpanExporter
from fastapi.testclient import TestClient
from pos_schemas import ModelProfile, parse_event

from .test_memory import answer, run


def run_with_approval(client, prompt, decision="allow", private=True):
    with client.websocket_connect("/ws") as ws:
        r = client.post("/tasks", json={"prompt": prompt, "private": private})
        assert r.status_code == 202, r.text
        tid = r.json()["task_id"]
        ev = []
        while True:
            e = parse_event(ws.receive_text())
            if e.task_id != tid:
                continue
            ev.append(e)
            if e.type == "approval.requested":
                client.post(f"/approvals/{e.payload.approval_id}", json={"decision": decision})
            if e.type.startswith("execution."):
                return tid, ev


@pytest.fixture
def obs_settings(real_settings, tmp_path):
    return replace(
        real_settings,
        audit_db_path=str(tmp_path / "audit.db"),
        traces_dir=str(tmp_path / "traces"),
        memory_db_path=str(tmp_path / "memory.db"),
    )


# ---------------------------------------------------------------- G3.10 audit


def test_audit_records_tools_approvals_and_model_calls(obs_settings):
    with TestClient(create_app(obs_settings)) as c:
        tid, ev = run_with_approval(c, "Research Zephyr and save the answer to a file")
        assert ev[-1].type == "execution.completed"
        rows = c.get("/audit", params={"task_id": tid}).json()
        kinds = {r["kind"] for r in rows}
        assert {
            "tool.started",
            "tool.completed",
            "approval.requested",
            "approval.granted",
            "model.metrics",
        } <= kinds
        audited = [e for e in ev if e.type.startswith(("tool.", "approval.", "model."))]
        assert len(rows) == len(audited)  # every audited event, exactly once
        assert {r["subject"] for r in rows if r["kind"] == "tool.started"} >= {
            "web_search",
            "fs_write",
        }
        v = c.get("/audit/verify").json()
        assert v["ok"] and v["rows"] == len(rows)


def test_audit_is_append_only_in_the_database(tmp_path):
    log = AuditLog(tmp_path / "a.db")
    log(_metrics_event())
    db = sqlite3.connect(tmp_path / "a.db")
    with pytest.raises(sqlite3.DatabaseError, match="append-only"):
        db.execute("UPDATE audit SET detail = '{}'")
    with pytest.raises(sqlite3.DatabaseError, match="append-only"):
        db.execute("DELETE FROM audit")
    assert log.verify() == {"ok": True, "rows": 1, "head": log.entries()[0]["hash"]}


def test_audit_hash_chain_detects_out_of_band_tampering(tmp_path):
    log = AuditLog(tmp_path / "a.db")
    for _ in range(3):
        log(_metrics_event())
    db = sqlite3.connect(tmp_path / "a.db", isolation_level=None)
    db.execute("DROP TRIGGER audit_no_update")  # attacker with file access
    db.execute("UPDATE audit SET detail = '{\"tampered\": true}' WHERE n = 2")
    assert log.verify() == {"ok": False, "rows": 3, "broken_at": 2}


def test_audit_chain_continues_across_restarts(obs_settings):
    for _ in range(2):
        with TestClient(create_app(obs_settings)) as c:
            run(c, "What is the Zephyr?")
    with TestClient(create_app(obs_settings)) as c:
        v = c.get("/audit/verify").json()
        tasks = {r["task_id"] for r in c.get("/audit").json()}
    assert v["ok"] and len(tasks) == 2


def test_audit_has_no_write_api(real_client):
    for method in ("post", "put", "patch", "delete"):
        assert getattr(real_client, method)("/audit").status_code == 405


# ---------------------------------------------------------------- G3.10 traces


def test_one_local_trace_file_per_task_with_parent_child_spans(obs_settings, tmp_path):
    with TestClient(create_app(obs_settings)) as c:
        tid, ev = run_with_approval(c, "Research Zephyr and save the answer to a file")
        app_tracer = c.app.state.tracer
    files = list((tmp_path / "traces").glob("*.jsonl"))
    assert [f.stem for f in files] == [tid]
    spans = [json.loads(line) for line in files[0].read_text(encoding="utf-8").splitlines()]
    by_id = {s["context"]["span_id"]: s for s in spans}
    roots = [s for s in spans if s["parent_id"] is None]
    assert [r["name"] for r in roots] == ["task"]
    assert len({s["context"]["trace_id"] for s in spans}) == 1
    names = {s["name"] for s in spans}
    assert {"agent:orchestrator", "agent:writer", "tool:web_search", "tool:fs_write"} <= names
    assert any(n.startswith("model:") for n in names)
    for s in spans:  # every child hangs off a span of the same trace
        assert s["parent_id"] is None or s["parent_id"] in by_id
    tool = next(s for s in spans if s["name"] == "tool:web_search")
    assert by_id[tool["parent_id"]]["name"].startswith("agent:research")
    n_tools = sum(1 for e in ev if e.type == "tool.started")
    assert sum(1 for s in spans if s["name"].startswith("tool:")) == n_tools
    # local file only: the one span processor exports to our file exporter, no network exporter
    procs = app_tracer.provider._active_span_processor._span_processors
    assert [type(p.span_exporter) for p in procs] == [LocalFileSpanExporter]
    assert not any(m.startswith("opentelemetry.exporter") for m in sys.modules)


def test_killed_run_still_closes_its_trace(obs_settings, tmp_path):
    slow = replace(obs_settings, stub_delay_s=0.3)
    with TestClient(create_app(slow)) as c, c.websocket_connect("/ws") as ws:
        tid = c.post("/tasks", json={"prompt": "What is the Zephyr?"}).json()["task_id"]
        while True:
            e = parse_event(ws.receive_text())
            if (
                e.task_id == tid
                and e.type == "agent.started"
                and e.payload.agent_id != "orchestrator"
            ):
                c.post(f"/tasks/{tid}/kill")
            if e.task_id == tid and e.type.startswith("execution."):
                break
    spans = [json.loads(x) for x in (tmp_path / "traces" / f"{tid}.jsonl").read_text().splitlines()]
    root = next(s for s in spans if s["name"] == "task")
    assert root["status"]["status_code"] == "ERROR"


# ---------------------------------------------------------------- G3.11 router


PROFILE = ModelProfile(provider="ollama", model="llama3.2:3b")


class FakeCloud:
    available = True

    def __init__(self) -> None:
        self.calls = 0

    async def generate(self, profile, messages, schema):
        self.calls += 1
        return await StubClient().generate(profile, messages, schema)


async def test_router_policy_table():
    cloud = FakeCloud()
    r = ModelRouter(StubClient(), cloud, cloud_kinds=frozenset({"write"}), offline=False)
    assert r.decide(private=True, kind="write").target == "local"
    assert r.decide(private=False, kind="write").target == "cloud"
    assert r.decide(private=False, kind="plan").target == "local"
    off = ModelRouter(StubClient(), cloud, cloud_kinds=frozenset({"write"}), offline=True)
    assert off.decide(private=False, kind="write").target == "local"
    nokey = ModelRouter(
        StubClient(),
        CloudClient(None, "http://x", "m"),
        cloud_kinds=frozenset({"write"}),
        offline=False,
    )
    d = nokey.decide(private=False, kind="write")
    assert d.target == "local" and "no CLOUD_API_KEY" in d.reason


async def test_cloud_adapter_is_disabled_without_key():
    c = CloudClient(None, "https://example.invalid/v1", "m")
    assert not c.available
    with pytest.raises(LLMError, match="disabled"):
        await c.generate(PROFILE, [Message("user", "hi")], {})


def _cloud_app(settings, monkeypatch, cloud, kinds=("plan", "research", "write")):
    monkeypatch.setattr("app.main.CloudClient", lambda *a, **k: cloud)
    return create_app(replace(settings, cloud_api_key="test-key", cloud_kinds=frozenset(kinds)))


def test_private_task_never_reaches_cloud(real_settings, monkeypatch):
    cloud = FakeCloud()
    with TestClient(_cloud_app(real_settings, monkeypatch, cloud)) as c:
        ev = run(c, "What is the Zephyr?")  # private is the default
        decisions = c.app.state.router.decisions
    assert ev[-1].type == "execution.completed"
    assert cloud.calls == 0 and decisions and all(d.target == "local" for d in decisions)
    assert all(d.reason == "private task: local only" for d in decisions)


def test_non_private_task_uses_cloud_only_for_allowed_kinds(real_settings, monkeypatch):
    cloud = FakeCloud()
    with TestClient(_cloud_app(real_settings, monkeypatch, cloud, kinds=("write",))) as c:
        _, ev = run_with_approval(c, "What is the Zephyr?", private=False)
        decisions = c.app.state.router.decisions
    assert ev[-1].type == "execution.completed"
    assert {d.target for d in decisions} == {"local", "cloud"}
    assert cloud.calls == sum(1 for d in decisions if d.target == "cloud") >= 1


# ---------------------------------------------------------------- G3.11 offline


def test_offline_web_tools_fail_gracefully_and_nothing_routes_to_cloud(real_settings, monkeypatch):
    cloud = FakeCloud()
    monkeypatch.setattr("app.main.CloudClient", lambda *a, **k: cloud)
    s = replace(real_settings, offline=True, cloud_api_key="k", cloud_kinds=frozenset({"write"}))
    with TestClient(create_app(s)) as c:
        _, ev = run_with_approval(c, "What is the Zephyr?", private=False)
        assert c.get("/runtime").json() == {
            "offline": True,
            "cloud_available": False,
            "cloud_kinds": ["write"],
        }
    failed = [e for e in ev if e.type == "tool.failed" and e.payload.tool_id == "web_search"]
    assert failed and failed[0].payload.error.startswith("offline")
    assert not any(
        e.type == "tool.started" and e.payload.tool_id in ("web_search", "fetch_url") for e in ev
    )
    assert ev[-1].type == "execution.completed"  # honest "could not verify", not a crash
    assert "Could not verify" in answer(ev)
    assert cloud.calls == 0


def test_offline_memory_only_task_completes(real_settings, tmp_path):
    s = replace(real_settings, offline=True, memory_db_path=str(tmp_path / "m.db"))
    with TestClient(create_app(s)) as c:
        ev = run(c, "Remember that my favourite harbour is Zephyr", "alpha")
        assert ev[-1].type == "execution.completed"
        ev = run(c, "What is my favourite harbour?", "alpha")
    assert ev[-1].type == "execution.completed"
    a = answer(ev)
    assert "Zephyr" in a and "[1]" in a
    assert not any(
        e.type == "tool.started" and e.payload.tool_id in ("web_search", "fetch_url") for e in ev
    )


def _metrics_event():
    from pos_schemas import make_event

    return make_event(
        "model.metrics",
        task_id="t1",
        seq=1,
        payload={
            "agent_id": "writer",
            "model": "stub",
            "attempt": 1,
            "ttft_ms": 1,
            "tok_s": 1.0,
            "total_ms": 2,
            "prompt_tokens": 1,
            "completion_tokens": 1,
        },
    )
