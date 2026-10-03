"""Per-run event emitter. The only way runtime code talks to the outside world."""

from __future__ import annotations

from typing import Any

from pos_schemas import make_event

from ..bus import EventBus


class RunContext:
    def __init__(self, task_id: str, bus: EventBus) -> None:
        self.task_id = task_id
        self._bus = bus
        self._seq = 0
        # agents currently working, in start order. With parallel branches several are
        # active at once; failures/kills are attributed to the most recently started one.
        self._active: list[str] = []

    @property
    def current_agent(self) -> str | None:
        return self._active[-1] if self._active else None

    @property
    def active(self) -> list[str]:
        return list(self._active)

    def emit(self, type_name: str, **payload: Any) -> None:
        """Validate + publish one event (raises ValidationError on a contract violation)."""
        ev = make_event(type_name, task_id=self.task_id, seq=self._seq, payload=payload)
        self._seq += 1
        self._bus.publish(ev)

    def start(self, agent_id: str, parent_id: str | None = "orchestrator") -> None:
        if agent_id in self._active:
            self._active.remove(agent_id)
        self._active.append(agent_id)
        self.emit("agent.started", agent_id=agent_id, parent_id=parent_id)

    def think(self, agent_id: str, message: str) -> None:
        self.emit("agent.thinking", agent_id=agent_id, message=message[:500])

    def done(self, agent_id: str, summary: str) -> None:
        self.emit("agent.completed", agent_id=agent_id, summary=summary[:500])
        if agent_id in self._active:
            self._active.remove(agent_id)
