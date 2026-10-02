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
        self.current_agent: str | None = None

    def emit(self, type_name: str, **payload: Any) -> None:
        """Validate + publish one event (raises ValidationError on a contract violation)."""
        ev = make_event(type_name, task_id=self.task_id, seq=self._seq, payload=payload)
        self._seq += 1
        self._bus.publish(ev)

    # agent lifecycle helpers keep `current_agent` honest for kill / failure attribution
    def start(self, agent_id: str, parent_id: str | None = "orchestrator") -> None:
        self.current_agent = agent_id
        self.emit("agent.started", agent_id=agent_id, parent_id=parent_id)

    def think(self, agent_id: str, message: str) -> None:
        self.emit("agent.thinking", agent_id=agent_id, message=message[:500])

    def done(self, agent_id: str, summary: str) -> None:
        self.emit("agent.completed", agent_id=agent_id, summary=summary[:500])
        if self.current_agent == agent_id:
            self.current_agent = "orchestrator" if agent_id != "orchestrator" else None
