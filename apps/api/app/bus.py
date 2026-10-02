"""In-process async event bus. Every published event is schema-validated."""

from __future__ import annotations

import asyncio
import logging
from collections import deque
from typing import TYPE_CHECKING

from pos_schemas import EventAdapter
from pydantic import BaseModel

if TYPE_CHECKING:
    from .persistence import EventRepository

log = logging.getLogger(__name__)


class EventBus:
    def __init__(
        self, queue_size: int = 1000, history: int = 500, repo: EventRepository | None = None
    ) -> None:
        self._subs: set[asyncio.Queue[BaseModel]] = set()
        self._repo = repo
        self._queue_size = queue_size
        self.history: deque[BaseModel] = deque(maxlen=history)

    def subscribe(self) -> asyncio.Queue[BaseModel]:
        q: asyncio.Queue[BaseModel] = asyncio.Queue(maxsize=self._queue_size)
        self._subs.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[BaseModel]) -> None:
        self._subs.discard(q)

    @property
    def subscriber_count(self) -> int:
        return len(self._subs)

    def publish(self, event: BaseModel) -> None:
        # Re-validate: nothing leaves the backend that the contract doesn't allow.
        EventAdapter.validate_python(event.model_dump())
        if self._repo is not None:  # persist before anyone sees it
            self._repo.append(event)
        self.history.append(event)
        for q in self._subs:
            if q.full():  # slow consumer: drop oldest, never block producers
                q.get_nowait()
                log.warning("bus: dropped event for slow subscriber")
            q.put_nowait(event)
