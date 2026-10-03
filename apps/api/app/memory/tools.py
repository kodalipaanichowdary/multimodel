"""Memory as tools: memory_search / memory_write go through the ToolRegistry, so every read and
write is permission-checked (memory.read / memory.write), audited, and shown as an event in chat."""

from __future__ import annotations

from typing import Any

from ..tools.registry import LocalHandler, ToolSpec
from .store import LAYERS, MemoryRepository

SEARCH = ToolSpec("memory_search", "memory.read", None)
WRITE = ToolSpec("memory_write", "memory.write", None)


def memory_tools(repo: MemoryRepository) -> dict[str, tuple[ToolSpec, LocalHandler]]:
    async def search(args: dict[str, Any]) -> dict[str, Any]:
        items = await repo.search(
            args["query"], args["project_id"], args.get("task_id"), int(args.get("k", 5))
        )
        return {
            "items": [i.model_dump() for i in items],
            "preview": f"{len(items)} memor{'y' if len(items) == 1 else 'ies'} recalled",
        }

    async def write(args: dict[str, Any]) -> dict[str, Any]:
        layer = args["layer"]
        if layer not in LAYERS:
            raise ValueError(f"unknown memory layer {layer!r}")
        item = await repo.add(
            layer, args["text"], args["project_id"], args.get("task_id"), args.get("source", "user")
        )
        return {
            "id": item.id,
            "layer": item.layer,
            "embedded": item.embedded,
            "preview": f"saved to {item.layer} memory: {item.text[:80]}",
        }

    return {SEARCH.id: (SEARCH, search), WRITE.id: (WRITE, write)}
