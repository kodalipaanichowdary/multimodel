"""Append-only audit log of tool calls, approvals and model calls (G3.10).

- Fed from the event bus (event-sourced): nothing in the agents has to remember to audit.
- Append-only is enforced by the database: UPDATE and DELETE triggers abort.
- Tamper-evident: every row stores sha256(prev_hash + canonical row); verify() re-walks the chain.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
from pathlib import Path
from typing import Any

from pydantic import BaseModel

AUDITED = (
    "tool.started",
    "tool.completed",
    "tool.failed",
    "approval.requested",
    "approval.granted",
    "approval.denied",
    "model.metrics",
)
GENESIS = "0" * 64


class AuditLog:
    def __init__(self, path: str | Path) -> None:
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._lock = threading.Lock()
        with self._lock:
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.execute(
                """CREATE TABLE IF NOT EXISTS audit (
                     n INTEGER PRIMARY KEY, ts TEXT NOT NULL, task_id TEXT NOT NULL, event_id TEXT UNIQUE NOT NULL,
                     kind TEXT NOT NULL, actor TEXT, subject TEXT, detail TEXT NOT NULL,
                     prev_hash TEXT NOT NULL, hash TEXT NOT NULL)"""
            )
            for op in ("UPDATE", "DELETE"):
                self._db.execute(
                    f"""CREATE TRIGGER IF NOT EXISTS audit_no_{op.lower()} BEFORE {op} ON audit
                        BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END"""
                )

    @staticmethod
    def _digest(prev: str, row: dict[str, Any]) -> str:
        canon = json.dumps(row, sort_keys=True, separators=(",", ":"), default=str)
        return hashlib.sha256((prev + canon).encode()).hexdigest()

    def __call__(self, event: BaseModel) -> None:
        """Bus sink: append audited events, ignore the rest."""
        d = json.loads(event.model_dump_json())
        if d["type"] not in AUDITED:
            return
        p = d["payload"]
        row = {
            "ts": d["ts"],
            "task_id": d["task_id"],
            "event_id": d["id"],
            "kind": d["type"],
            "actor": p.get("agent_id") or p.get("by"),
            "subject": p.get("tool_id") or p.get("model") or p.get("approval_id"),
            "detail": json.dumps(p, sort_keys=True, default=str),
        }
        with self._lock:
            last = self._db.execute("SELECT hash FROM audit ORDER BY n DESC LIMIT 1").fetchone()
            prev = last[0] if last else GENESIS
            self._db.execute(
                "INSERT OR IGNORE INTO audit (ts, task_id, event_id, kind, actor, subject, detail, prev_hash, hash) "
                "VALUES (:ts, :task_id, :event_id, :kind, :actor, :subject, :detail, :prev, :hash)",
                {**row, "prev": prev, "hash": self._digest(prev, row)},
            )

    def entries(self, task_id: str | None = None, limit: int = 500) -> list[dict[str, Any]]:
        sql = "SELECT n, ts, task_id, event_id, kind, actor, subject, detail, prev_hash, hash FROM audit"
        args: list[Any] = []
        if task_id:
            sql += " WHERE task_id = ?"
            args.append(task_id)
        with self._lock:
            rows = self._db.execute(sql + " ORDER BY n LIMIT ?", [*args, limit]).fetchall()
        keys = (
            "n",
            "ts",
            "task_id",
            "event_id",
            "kind",
            "actor",
            "subject",
            "detail",
            "prev_hash",
            "hash",
        )
        return [dict(zip(keys, r, strict=True)) for r in rows]

    def verify(self) -> dict[str, Any]:
        """Re-walk the hash chain. ok=False names the first row that does not match."""
        prev = GENESIS
        with self._lock:
            rows = self._db.execute(
                "SELECT n, ts, task_id, event_id, kind, actor, subject, detail, prev_hash, hash FROM audit ORDER BY n"
            ).fetchall()
        for n, ts, task_id, event_id, kind, actor, subject, detail, prev_hash, h in rows:
            row = {
                "ts": ts,
                "task_id": task_id,
                "event_id": event_id,
                "kind": kind,
                "actor": actor,
                "subject": subject,
                "detail": detail,
            }
            if prev_hash != prev or h != self._digest(prev, row):
                return {"ok": False, "rows": len(rows), "broken_at": n}
            prev = h
        return {"ok": True, "rows": len(rows), "head": prev}


class NullAuditLog:
    def __call__(self, event: BaseModel) -> None:
        return None

    def entries(self, task_id: str | None = None, limit: int = 500) -> list[dict[str, Any]]:
        return []

    def verify(self) -> dict[str, Any]:
        return {"ok": True, "rows": 0, "head": GENESIS}


def open_audit(path: str) -> AuditLog | NullAuditLog:
    return NullAuditLog() if path.strip().lower() in ("", "none", "off") else AuditLog(path)
