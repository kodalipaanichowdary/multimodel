"""P1 ONLY: scripted fake execution. Replaced by the real runtime in P2.

Emits a fixed, contract-valid event sequence so the UI can be built against
real wire traffic. A prompt containing the word "fail" takes the failure path.
"""

from __future__ import annotations

import asyncio
import re
import time
from collections.abc import Iterator
from typing import Any
from uuid import uuid4

from pos_schemas import make_event

from .bus import EventBus

Step = tuple[str, dict[str, Any]]


def script(prompt: str, task_id: str) -> Iterator[Step]:
    fail = re.search(r"\bfail\b", prompt, re.IGNORECASE) is not None
    c1, c2, appr, art = (f"{p}-{task_id[:8]}" for p in ("call1", "call2", "appr", "art"))

    yield "task.created", {"prompt": prompt}
    yield "agent.started", {"agent_id": "orchestrator", "parent_id": None}
    yield "agent.thinking", {"agent_id": "orchestrator", "message": "Decomposing task"}
    yield (
        "task.planned",
        {
            "steps": [
                {"agent_id": "research", "goal": "Gather sources"},
                {"agent_id": "writer", "goal": "Draft artifact"},
                {"agent_id": "validator", "goal": "Check output"},
            ]
        },
    )
    yield "agent.started", {"agent_id": "research", "parent_id": "orchestrator"}
    yield "agent.thinking", {"agent_id": "research", "message": "Choosing queries"}
    yield (
        "tool.started",
        {
            "agent_id": "research",
            "tool_id": "web_search",
            "call_id": c1,
            "args": {"q": prompt[:80], "k": 3},
        },
    )
    if fail:
        yield (
            "tool.failed",
            {
                "agent_id": "research",
                "tool_id": "web_search",
                "call_id": c1,
                "error": "mock: upstream timeout",
            },
        )
        yield "execution.failed", {"error": "research step failed", "agent_id": "research"}
        return
    yield (
        "tool.completed",
        {
            "agent_id": "research",
            "tool_id": "web_search",
            "call_id": c1,
            "duration_ms": 420,
            "result_preview": "3 results (mock)",
        },
    )
    yield "agent.completed", {"agent_id": "research", "summary": "3 sources found (mock)"}
    yield "agent.started", {"agent_id": "writer", "parent_id": "orchestrator"}
    yield "agent.thinking", {"agent_id": "writer", "message": "Outlining"}
    yield (
        "approval.requested",
        {
            "approval_id": appr,
            "agent_id": "writer",
            "tool_id": "fs_write",
            "reason": "write report.md",
        },
    )
    yield "approval.granted", {"approval_id": appr, "by": "mock-auto"}
    yield (
        "tool.started",
        {
            "agent_id": "writer",
            "tool_id": "fs_write",
            "call_id": c2,
            "args": {"path": "report.md"},
        },
    )
    yield (
        "tool.completed",
        {
            "agent_id": "writer",
            "tool_id": "fs_write",
            "call_id": c2,
            "duration_ms": 35,
            "result_preview": "wrote 1.2 KB (mock)",
        },
    )
    yield "agent.completed", {"agent_id": "writer", "summary": "Draft ready (mock)"}
    yield "agent.started", {"agent_id": "validator", "parent_id": "orchestrator"}
    yield "agent.thinking", {"agent_id": "validator", "message": "Checking schema"}
    yield "agent.completed", {"agent_id": "validator", "summary": "valid (mock)"}
    yield (
        "artifact.created",
        {
            "artifact_id": art,
            "agent_id": "writer",
            "title": "Report",
            "mime": "text/markdown",
            "content": f"# Report (mock)\n\nTask: {prompt}\n",
        },
    )
    yield "agent.completed", {"agent_id": "orchestrator", "summary": "Done (mock)"}
    yield "execution.completed", {"duration_ms": 0, "artifact_ids": [art]}


class MockExecutor:
    def __init__(self, bus: EventBus, step_delay_s: float) -> None:
        self._bus = bus
        self._delay = step_delay_s
        self._running: set[asyncio.Task[None]] = set()

    def submit(self, prompt: str) -> str:
        task_id = str(uuid4())
        t = asyncio.create_task(self._run(task_id, prompt), name=f"mock-{task_id}")
        self._running.add(t)
        t.add_done_callback(self._running.discard)
        return task_id

    async def _run(self, task_id: str, prompt: str) -> None:
        started = time.monotonic()
        for seq, (etype, payload) in enumerate(script(prompt, task_id)):
            if etype == "execution.completed":
                payload["duration_ms"] = int((time.monotonic() - started) * 1000)
            self._bus.publish(make_event(etype, task_id=task_id, seq=seq, payload=payload))
            await asyncio.sleep(self._delay)
