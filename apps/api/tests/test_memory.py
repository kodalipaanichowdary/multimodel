"""G3.9 memory: 3 layers, persistence across sessions, project isolation, list/search/delete,
every write is an event, vectors when an embedder is present, FTS5 fallback when not."""

import math
from dataclasses import replace

import pytest
from app.main import create_app
from app.memory.store import SqliteMemoryRepository
from fastapi.testclient import TestClient
from pos_schemas import parse_event


def run(client, prompt, project="default"):
    with client.websocket_connect("/ws") as ws:
        r = client.post("/tasks", json={"prompt": prompt, "project_id": project})
        assert r.status_code == 202, r.text
        tid = r.json()["task_id"]
        ev = []
        while True:
            e = parse_event(ws.receive_text())
            if e.task_id == tid:
                ev.append(e)
                if e.type.startswith("execution."):
                    return ev


def answer(ev):
    return next(e.payload.content for e in ev if e.type == "artifact.created")


def payload_text(ev):
    return " ".join(e.model_dump_json() for e in ev)


@pytest.fixture
def mem_settings(real_settings, tmp_path):
    return replace(real_settings, memory_db_path=str(tmp_path / "memory.db"))


def test_fact_saved_in_session_1_is_recalled_in_session_2(mem_settings):
    with TestClient(create_app(mem_settings)) as c:  # session 1
        ev = run(c, "Remember that my favourite harbour is Zephyr", "alpha")
        writes = [
            e for e in ev if e.type == "tool.completed" and e.payload.tool_id == "memory_write"
        ]
        assert len(writes) == 1 and "saved to project memory" in writes[0].payload.result_preview
        assert "Saved to **project** memory" in answer(ev)
        assert not any(e.type == "tool.started" and e.payload.tool_id == "web_search" for e in ev)
    with TestClient(create_app(mem_settings)) as c:  # session 2: new process state, same file
        ev = run(c, "What is my favourite harbour?", "alpha")
        recalled = [
            e for e in ev if e.type == "tool.completed" and e.payload.tool_id == "memory_search"
        ]
        assert recalled and recalled[0].payload.result_preview == "1 memory recalled"
        a = answer(ev)
        assert "Zephyr" in a and "[1]" in a
        assert any(
            e.type == "agent.completed"
            and e.payload.agent_id == "validator"
            and e.payload.summary.startswith("grounded")
            for e in ev
        )


def test_project_a_memory_never_visible_in_project_b(mem_settings):
    with TestClient(create_app(mem_settings)) as c:
        run(c, "Remember that the launch code word is Falcon", "project-a")
        ev_b = run(c, "What is the launch code word?", "project-b")
        assert "Falcon" not in payload_text(ev_b)  # not in answer, not in any event
        assert not any(
            e.type == "tool.started" and e.payload.tool_id == "memory_search" for e in ev_b
        )
        ev_a = run(c, "What is the launch code word?", "project-a")
        assert "Falcon" in answer(ev_a)
        assert c.get("/memory", params={"project_id": "project-b"}).json() == []
        a_items = c.get("/memory", params={"project_id": "project-a"}).json()
        assert [i["text"] for i in a_items] == ["the launch code word is Falcon."]
        # project B cannot delete project A's memory either
        assert (
            c.delete(f"/memory/{a_items[0]['id']}", params={"project_id": "project-b"}).status_code
            == 404
        )


def test_personal_layer_is_visible_in_every_project(mem_settings):
    with TestClient(create_app(mem_settings)) as c:
        ev = run(c, "Remember about me that I prefer metric units", "one")
        assert "Saved to **personal** memory (every project)" in answer(ev)
        for project in ("one", "two"):
            items = c.get("/memory", params={"project_id": project}).json()
            assert [i["layer"] for i in items] == ["personal"]


def test_list_search_delete_api(mem_settings):
    with TestClient(create_app(mem_settings)) as c:
        run(c, "Remember that the build server is called Orion", "p")
        run(c, "Remember that the release day is Friday", "p")
        items = c.get("/memory", params={"project_id": "p"}).json()
        assert len(items) == 2
        hit = c.get("/memory", params={"project_id": "p", "q": "which day is the release"}).json()
        assert hit[0]["text"].startswith("the release day")
        assert c.delete(f"/memory/{hit[0]['id']}", params={"project_id": "p"}).status_code == 204
        assert [i["text"] for i in c.get("/memory", params={"project_id": "p"}).json()] == [
            "the build server is called Orion."
        ]
        assert c.delete("/memory/mem-nope", params={"project_id": "p"}).status_code == 404
        assert c.get("/memory", params={"project_id": "Bad Id"}).status_code == 422


def test_execution_layer_notes_from_parallel_branches(mem_settings):
    with TestClient(create_app(mem_settings)) as c:
        ev = run(c, "Compare Zephyr Harbor, Quillon Library and Marsh Observatory", "p")
        notes = [
            e for e in ev if e.type == "tool.completed" and e.payload.tool_id == "memory_write"
        ]
        assert len(notes) == 3 and all(
            "execution memory" in n.payload.result_preview for n in notes
        )
        tid = ev[0].task_id
        execs = [
            i for i in c.get("/memory", params={"project_id": "p", "layer": "execution"}).json()
        ]
        assert len(execs) == 3 and {i["task_id"] for i in execs} == {tid}


def test_memory_tools_need_permissions(mem_settings):
    """The writer may not write memory: permission is checked like any tool."""
    import asyncio

    from app.agent_runtime.approvals import ApprovalBroker
    from app.agent_runtime.context import RunContext
    from app.bus import EventBus
    from app.memory.tools import memory_tools
    from app.registry import AgentRegistry
    from app.tools.registry import PermissionDenied, ToolRegistry

    from .conftest import REPO

    repo = SqliteMemoryRepository(":memory:")
    reg = ToolRegistry(REPO / "mcp", ApprovalBroker(1), local=memory_tools(repo))
    writer = AgentRegistry.from_dir(REPO / "agents").get("writer")
    ctx = RunContext("t" * 36, EventBus())
    with pytest.raises(PermissionDenied):
        asyncio.run(
            reg.call(
                ctx, writer, "memory_write", {"layer": "project", "text": "x", "project_id": "p"}
            )
        )


# ------------------------------------------------------------------ store: vectors + FTS fallback


def bag(texts):
    """Deterministic fake embedder: bag of known words -> vector (synonyms share a dimension)."""
    vocab = {
        "harbour": 0,
        "harbor": 0,
        "port": 0,
        "boat": 1,
        "ship": 1,
        "vessel": 1,
        "library": 2,
        "book": 2,
        "favourite": 3,
        "favorite": 3,
    }

    async def embed(batch):
        out = []
        for t in batch:
            v = [0.0] * 4
            for w in t.lower().replace(".", " ").replace("?", " ").split():
                if w in vocab:
                    v[vocab[w]] += 1
            out.append(v if any(v) else [1e-6] * 4)
        return out

    return embed


@pytest.mark.asyncio
async def test_vector_search_finds_synonyms_fts_cannot():
    repo = SqliteMemoryRepository(":memory:", embedder=bag(None))
    a = await repo.add("project", "My favourite port is Zephyr.", "p")
    await repo.add("project", "The library has many books.", "p")
    assert a.embedded
    hits = await repo.search("which harbor do I like?", "p")  # no shared keyword with the fact
    # query [harbor] vs fact [favourite, port]: cosine 1/sqrt(2) = 0.707 >= MIN_COSINE 0.55
    assert hits and hits[0].id == a.id and math.isclose(hits[0].score or 0, 0.707, abs_tol=0.01)
    fts_only = SqliteMemoryRepository(":memory:")  # no embedder: FTS5 fallback
    await fts_only.add("project", "My favourite port is Zephyr.", "p")
    assert await fts_only.search("which harbor do I like?", "p") == []
    assert (await fts_only.search("favourite port", "p"))[0].text.startswith("My favourite port")


@pytest.mark.asyncio
async def test_embedder_failure_falls_back_to_fts():
    async def broken(_):
        raise RuntimeError("ollama down")

    repo = SqliteMemoryRepository(":memory:", embedder=broken)
    item = await repo.add("personal", "I prefer metric units.", "p")
    assert not item.embedded
    assert (await repo.search("metric units", "q"))[
        0
    ].id == item.id  # personal: visible from any project


@pytest.mark.asyncio
async def test_execution_scope_is_per_task():
    repo = SqliteMemoryRepository(":memory:")
    await repo.add("execution", "scratch note alpha", "p", task_id="t1")
    assert await repo.search("scratch note", "p", task_id="t2") == []
    assert len(await repo.search("scratch note", "p", task_id="t1")) == 1
