"""Memory layer: personal / project / execution, in SQLite (FTS5 + optional embedding vectors).

Scope rules (enforced here, never in the UI):
  personal  -> visible in every project of this user
  project   -> visible only inside its project_id
  execution -> visible only to the task that wrote it (task_id)

Search: if an embedder is configured and the query embeds, rank the scoped rows by cosine
similarity; otherwise (or for rows without vectors) FTS5 BM25 keyword search.
"""

from __future__ import annotations

import math
import re
import sqlite3
import struct
import threading
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Literal, Protocol
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field

Layer = Literal["personal", "project", "execution"]
LAYERS: tuple[Layer, ...] = ("personal", "project", "execution")
PROJECT_ID = r"^[a-z0-9][a-z0-9_-]{0,39}$"
Embedder = Callable[[list[str]], Awaitable[list[list[float]]]]
MIN_COSINE = 0.55

_STOP = set(
    "the a an of is are was were who what which when where how my your our their his her its "
    "me you we they it this that these those to for in on at by with and or do does did".split()
)


class MemoryItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    layer: Layer
    project_id: str = Field(pattern=PROJECT_ID)
    task_id: str | None = None
    text: str = Field(min_length=1, max_length=2000)
    source: str = "user"
    created_at: float
    embedded: bool = False
    score: float | None = None


class MemoryRepository(Protocol):
    async def add(
        self,
        layer: Layer,
        text: str,
        project_id: str,
        task_id: str | None = None,
        source: str = "user",
    ) -> MemoryItem: ...
    async def search(
        self, query: str, project_id: str, task_id: str | None = None, k: int = 5
    ) -> list[MemoryItem]: ...
    def list(self, project_id: str, layer: Layer | None = None) -> list[MemoryItem]: ...
    def delete(self, item_id: str, project_id: str) -> bool: ...


def _pack(v: list[float]) -> bytes:
    return struct.pack(f"{len(v)}f", *v)


def _unpack(b: bytes) -> list[float]:
    return list(struct.unpack(f"{len(b) // 4}f", b))


def _cos(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=False))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def fts_query(text: str) -> str | None:
    words = [w for w in re.findall(r"[a-z0-9]{3,}", text.lower()) if w not in _STOP]
    return " OR ".join(f'"{w}"' for w in dict.fromkeys(words)) or None


# scope clause on the aliased memories table "m"; params: (project_id, project_id, task_id)
_SCOPE_M = """(m.layer = 'personal'
             OR (m.layer = 'project' AND m.project_id = ?)
             OR (m.layer = 'execution' AND m.project_id = ? AND m.task_id IS ?))"""


class SqliteMemoryRepository:
    def __init__(self, path: str | Path, embedder: Embedder | None = None) -> None:
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._lock = threading.Lock()
        self.embedder = embedder
        with self._lock:
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.execute(
                """CREATE TABLE IF NOT EXISTS memories (
                     rowid INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, layer TEXT NOT NULL,
                     project_id TEXT NOT NULL, task_id TEXT, text TEXT NOT NULL, source TEXT NOT NULL,
                     created_at REAL NOT NULL, vec BLOB)"""
            )
            self._db.execute(
                "CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(text, content='memories', content_rowid='rowid')"
            )
            self._db.execute(
                "CREATE INDEX IF NOT EXISTS ix_mem_scope ON memories(layer, project_id, task_id)"
            )

    def _row(self, r: tuple, score: float | None = None) -> MemoryItem:
        id_, layer, project_id, task_id, text, source, created, vec = r
        return MemoryItem(
            id=id_,
            layer=layer,
            project_id=project_id,
            task_id=task_id,
            text=text,
            source=source,
            created_at=created,
            embedded=vec is not None,
            score=score,
        )

    async def _embed(self, text: str) -> list[float] | None:
        if self.embedder is None:
            return None
        try:
            return (await self.embedder([text]))[0]
        except Exception:  # embeddings are optional: FTS5 still works
            return None

    async def add(
        self,
        layer: Layer,
        text: str,
        project_id: str,
        task_id: str | None = None,
        source: str = "user",
    ) -> MemoryItem:
        item = MemoryItem(
            id=f"mem-{uuid4().hex[:12]}",
            layer=layer,
            project_id=project_id,
            task_id=task_id if layer == "execution" else None,
            text=text.strip()[:2000],
            source=source,
            created_at=time.time(),
        )
        vec = await self._embed(item.text)
        with self._lock:
            cur = self._db.execute(
                "INSERT INTO memories (id, layer, project_id, task_id, text, source, created_at, vec) VALUES (?,?,?,?,?,?,?,?)",
                (
                    item.id,
                    item.layer,
                    item.project_id,
                    item.task_id,
                    item.text,
                    item.source,
                    item.created_at,
                    _pack(vec) if vec else None,
                ),
            )
            self._db.execute(
                "INSERT INTO memories_fts(rowid, text) VALUES (?, ?)", (cur.lastrowid, item.text)
            )
        return item.model_copy(update={"embedded": vec is not None})

    async def search(
        self, query: str, project_id: str, task_id: str | None = None, k: int = 5
    ) -> list[MemoryItem]:
        qvec = await self._embed(query)
        cols = "m.id, m.layer, m.project_id, m.task_id, m.text, m.source, m.created_at, m.vec"
        with self._lock:
            scoped = self._db.execute(
                f"SELECT {cols} FROM memories m WHERE {_SCOPE_M}",
                (project_id, project_id, task_id),
            ).fetchall()
            fts = fts_query(query)
            lexical = (
                self._db.execute(
                    f"""SELECT {cols}, bm25(memories_fts) FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid
                        WHERE memories_fts MATCH ? AND {_SCOPE_M}
                        ORDER BY bm25(memories_fts) LIMIT ?""",
                    (fts, project_id, project_id, task_id, k),
                ).fetchall()
                if fts
                else []
            )
        hits: dict[str, MemoryItem] = {}
        if qvec is not None:
            for r in scoped:
                if r[7] is not None:
                    sim = _cos(qvec, _unpack(r[7]))
                    if sim >= MIN_COSINE:
                        hits[r[0]] = self._row(r, round(sim, 3))
        for r in lexical:
            if r[0] not in hits:
                hits[r[0]] = self._row(r[:8], round(-float(r[8]), 3))
        return sorted(hits.values(), key=lambda m: -(m.score or 0))[:k]

    def list(self, project_id: str, layer: Layer | None = None) -> list[MemoryItem]:
        sql = "SELECT id, layer, project_id, task_id, text, source, created_at, vec FROM memories WHERE (layer = 'personal' OR project_id = ?)"
        args: list = [project_id]
        if layer:
            sql += " AND layer = ?"
            args.append(layer)
        with self._lock:
            rows = self._db.execute(sql + " ORDER BY created_at DESC", args).fetchall()
        return [self._row(r) for r in rows]

    def delete(self, item_id: str, project_id: str) -> bool:
        """Deletes only inside the caller's scope (own project, or personal)."""
        with self._lock:
            row = self._db.execute(
                "SELECT rowid, text FROM memories WHERE id = ? AND (layer = 'personal' OR project_id = ?)",
                (item_id, project_id),
            ).fetchone()
            if not row:
                return False
            self._db.execute(
                "INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', ?, ?)", row
            )
            self._db.execute("DELETE FROM memories WHERE rowid = ?", (row[0],))
        return True


class NullMemoryRepository:
    embedder = None

    async def add(self, layer, text, project_id, task_id=None, source="user"):  # type: ignore[no-untyped-def]
        return MemoryItem(
            id="mem-null", layer=layer, project_id=project_id, text=text, created_at=time.time()
        )

    async def search(self, query, project_id, task_id=None, k=5):  # type: ignore[no-untyped-def]
        return []

    def list(self, project_id, layer=None):  # type: ignore[no-untyped-def]
        return []

    def delete(self, item_id, project_id):  # type: ignore[no-untyped-def]
        return False


def open_memory(
    path: str, embedder: Embedder | None
) -> SqliteMemoryRepository | NullMemoryRepository:
    if path.strip().lower() in ("", "none", "off"):
        return NullMemoryRepository()
    return SqliteMemoryRepository(path, embedder)
