"""UI projection graph. Not the execution graph — the backend owns truth."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

NodeKind = Literal["agent", "tool", "memory", "task", "artifact"]
NodeState = Literal[
    "idle", "queued", "thinking", "running", "waiting_approval", "completed", "error"
]
EdgeKind = Literal["delegates", "calls", "produces", "reads"]


class Position(BaseModel):
    model_config = ConfigDict(extra="forbid")
    x: float
    y: float


class Node(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1)
    kind: NodeKind
    label: str = Field(min_length=1)
    state: NodeState = "idle"
    ref_id: str = Field(min_length=1, description="id of the backing entity")
    position: Position | None = None


class Edge(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1)
    source: str = Field(min_length=1)
    target: str = Field(min_length=1)
    kind: EdgeKind
    active: bool = False
