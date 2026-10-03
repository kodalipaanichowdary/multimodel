from dataclasses import replace

from app.main import create_app
from app.persistence import SqliteEventRepository
from fastapi.testclient import TestClient
from pos_schemas import make_event


def ev(t, task, seq, **p):
    return make_event(t, task_id=task, seq=seq, payload=p)


def test_repository_roundtrip(tmp_path):
    repo = SqliteEventRepository(tmp_path / "pos.db")
    repo.append(ev("task.created", "a", 0, prompt="first"))
    repo.append(ev("execution.completed", "a", 1, duration_ms=5, artifact_ids=[]))
    repo.append(ev("task.created", "b", 0, prompt="second"))
    e = ev("task.created", "c", 0, prompt="dup")
    repo.append(e)
    repo.append(e)  # idempotent
    tasks = {t.task_id: t for t in repo.tasks()}
    assert (
        tasks["a"].status == "completed" and tasks["a"].prompt == "first" and tasks["a"].events == 2
    )
    assert tasks["b"].status == "running"
    assert [x["seq"] for x in repo.events("a")] == [0, 1]
    assert sorted(repo.unfinished()) == [("b", 0), ("c", 0)]
    assert repo.verify() == 4


def test_events_survive_restart_and_open_runs_are_closed(tmp_path, settings):
    db = str(tmp_path / "pos.db")
    s = replace(settings, db_path=db, mock_step_delay_s=0.0)
    with TestClient(create_app(s)) as c, c.websocket_connect("/ws") as ws:
        tid = c.post("/tasks", json={"prompt": "persist me"}).json()["task_id"]
        while True:
            if '"execution.' in ws.receive_text():
                break
    # a run that was mid-flight when the process died
    SqliteEventRepository(db).append(ev("task.created", "orphan", 0, prompt="crashed"))
    with TestClient(create_app(s)) as c:
        tasks = {t["task_id"]: t for t in c.get("/tasks").json()}
        assert tasks[tid]["status"] == "completed" and tasks[tid]["events"] == 22
        assert tasks["orphan"]["status"] == "failed"
        last = c.get("/tasks/orphan/events").json()[-1]
        assert last["type"] == "execution.failed" and "interrupted" in last["payload"]["error"]
        assert c.get("/tasks/missing/events").status_code == 404
