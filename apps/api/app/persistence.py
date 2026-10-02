"""Event log persistence. Repository interface + SQLite implementation (stdlib sqlite3).

The bus appends every event before fan-out, so anything a client saw is on disk.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path
from typing import Any, Protocol

from pos_schemas import parse_event
from pydantic import BaseModel

TERMINAL = ("execution.completed", "execution.failed")


class TaskSummary(BaseModel):
    task_id: str
    prompt: str
    status: str  # running | completed | failed
    started: str
    updated: str
    events: int


class EventRepository(Protocol):
    def append(self, event: BaseModel) -> None: ...
    def tasks(self, limit: int = 20) -> list[TaskSummary]: ...
    def events(self, task_id: str) -> list[dict[str, Any]]: ...
    def unfinished(self) -> list[tuple[str, int]]: ...


class SqliteEventRepository:
    def __init__(self, path: str | Path) -> None:
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._lock = threading.Lock()
        with self._lock:
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.execute(
                """CREATE TABLE IF NOT EXISTS events (
                     id TEXT PRIMARY KEY, task_id TEXT NOT NULL, seq INTEGER NOT NULL,
                     type TEXT NOT NULL, ts TEXT NOT NULL, body TEXT NOT NULL,
                     UNIQUE (task_id, seq))"""
            )
            self._db.execute("CREATE INDEX IF NOT EXISTS ix_events_task ON events(task_id, seq)")

    def append(self, event: BaseModel) -> None:
        body = event.model_dump_json()
        d = json.loads(body)
        with self._lock:
            self._db.execute(
                "INSERT OR IGNORE INTO events (id, task_id, seq, type, ts, body) VALUES (?,?,?,?,?,?)",
                (d["id"], d["task_id"], d["seq"], d["type"], d["ts"], body),
            )

    def tasks(self, limit: int = 20) -> list[TaskSummary]:
        with self._lock:
            rows = self._db.execute(
                """SELECT task_id, MIN(ts), MAX(ts), COUNT(*),
                          (SELECT body FROM events e2 WHERE e2.task_id = e.task_id AND e2.type = 'task.created' LIMIT 1),
                          (SELECT type FROM events e3 WHERE e3.task_id = e.task_id ORDER BY seq DESC LIMIT 1)
                   FROM events e GROUP BY task_id ORDER BY MIN(ts) DESC LIMIT ?""",
                (limit,),
            ).fetchall()
        out = []
        for task_id, started, updated, n, created, last in rows:
            prompt = json.loads(created)["payload"]["prompt"] if created else ""
            status = {"execution.completed": "completed", "execution.failed": "failed"}.get(
                last, "running"
            )
            out.append(
                TaskSummary(
                    task_id=task_id,
                    prompt=prompt,
                    status=status,
                    started=started,
                    updated=updated,
                    events=n,
                )
            )
        return out

    def events(self, task_id: str) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "SELECT body FROM events WHERE task_id = ? ORDER BY seq", (task_id,)
            ).fetchall()
        return [json.loads(r[0]) for r in rows]

    def unfinished(self) -> list[tuple[str, int]]:
        """(task_id, last_seq) for runs with no terminal event, e.g. after a crash/restart."""
        with self._lock:
            rows = self._db.execute(
                f"""SELECT task_id, MAX(seq) FROM events GROUP BY task_id
                    HAVING SUM(type IN {TERMINAL!r}) = 0"""
            ).fetchall()
        return [(t, s) for t, s in rows]

    def count(self) -> int:
        with self._lock:
            return self._db.execute("SELECT COUNT(*) FROM events").fetchone()[0]

    def verify(self) -> int:
        """Re-validate every stored event against the contract; returns how many passed."""
        with self._lock:
            rows = self._db.execute("SELECT body FROM events").fetchall()
        for (body,) in rows:
            parse_event(body)
        return len(rows)
