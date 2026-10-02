"""Event bus contract. Mirrored 1:1 by packages/schemas/ts/src/events.ts (zod).

Every event: envelope {id, type, task_id, seq, ts} + typed payload,
discriminated on `type`.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated, Any, Literal, Union
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, StrictInt, TypeAdapter


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ---------- payloads ----------


class PlanStep(_Strict):
    agent_id: str = Field(min_length=1)
    goal: str = Field(min_length=1)


class TaskCreated(_Strict):
    prompt: str = Field(min_length=1, max_length=4000)


class TaskPlanned(_Strict):
    steps: list[PlanStep] = Field(min_length=1)


class AgentStarted(_Strict):
    agent_id: str = Field(min_length=1)
    parent_id: str | None = None


class AgentThinking(_Strict):
    agent_id: str = Field(min_length=1)
    message: str


class AgentCompleted(_Strict):
    agent_id: str = Field(min_length=1)
    summary: str


class ToolStarted(_Strict):
    agent_id: str = Field(min_length=1)
    tool_id: str = Field(min_length=1)
    call_id: str = Field(min_length=1)
    args: dict[str, Any] = Field(default_factory=dict)


class ToolCompleted(_Strict):
    agent_id: str = Field(min_length=1)
    tool_id: str = Field(min_length=1)
    call_id: str = Field(min_length=1)
    duration_ms: StrictInt = Field(ge=0)
    result_preview: str = ""


class ToolFailed(_Strict):
    agent_id: str = Field(min_length=1)
    tool_id: str = Field(min_length=1)
    call_id: str = Field(min_length=1)
    error: str = Field(min_length=1)


class ApprovalRequested(_Strict):
    approval_id: str = Field(min_length=1)
    agent_id: str = Field(min_length=1)
    tool_id: str = Field(min_length=1)
    reason: str = Field(min_length=1)


class ApprovalGranted(_Strict):
    approval_id: str = Field(min_length=1)
    by: str = Field(min_length=1)


class ApprovalDenied(_Strict):
    approval_id: str = Field(min_length=1)
    by: str = Field(min_length=1, description="'user' or 'timeout'")
    reason: str = ""


class ModelMetrics(_Strict):
    """One model call (one attempt). Emitted by the real runtime after each generate()."""

    agent_id: str = Field(min_length=1)
    model: str = Field(min_length=1)
    attempt: StrictInt = Field(ge=1)
    ttft_ms: StrictInt = Field(ge=0)
    tok_s: float = Field(ge=0)
    total_ms: StrictInt = Field(ge=0)
    prompt_tokens: StrictInt = Field(ge=0)
    completion_tokens: StrictInt = Field(ge=0)


class ArtifactCreated(_Strict):
    artifact_id: str = Field(min_length=1)
    agent_id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    mime: str = Field(min_length=1)
    content: str


class ExecutionCompleted(_Strict):
    duration_ms: StrictInt = Field(ge=0)
    artifact_ids: list[str] = Field(default_factory=list)


class ExecutionFailed(_Strict):
    error: str = Field(min_length=1)
    agent_id: str | None = None


# ---------- envelope ----------


def _now() -> datetime:
    return datetime.now(timezone.utc)


class _Envelope(_Strict):
    id: str = Field(default_factory=lambda: str(uuid4()), min_length=1)
    task_id: str = Field(min_length=1)
    seq: StrictInt = Field(ge=0)
    ts: datetime = Field(default_factory=_now)


def _event(type_name: str, payload_model: type[BaseModel]) -> type[_Envelope]:
    cls_name = "".join(p.capitalize() for p in type_name.replace(".", "_").split("_")) + "Event"
    return type(
        cls_name,
        (_Envelope,),
        {
            "__annotations__": {"type": Literal[type_name], "payload": payload_model},  # type: ignore[valid-type]
            "__module__": __name__,
        },
    )


EVENT_PAYLOADS: dict[str, type[BaseModel]] = {
    "task.created": TaskCreated,
    "task.planned": TaskPlanned,
    "agent.started": AgentStarted,
    "agent.thinking": AgentThinking,
    "agent.completed": AgentCompleted,
    "tool.started": ToolStarted,
    "tool.completed": ToolCompleted,
    "tool.failed": ToolFailed,
    "approval.requested": ApprovalRequested,
    "approval.granted": ApprovalGranted,
    "approval.denied": ApprovalDenied,
    "model.metrics": ModelMetrics,
    "artifact.created": ArtifactCreated,
    "execution.completed": ExecutionCompleted,
    "execution.failed": ExecutionFailed,
}
EVENT_TYPES: tuple[str, ...] = tuple(EVENT_PAYLOADS)

EVENT_MODELS: dict[str, type[_Envelope]] = {t: _event(t, p) for t, p in EVENT_PAYLOADS.items()}

Event = Annotated[Union[tuple(EVENT_MODELS.values())], Field(discriminator="type")]  # type: ignore[valid-type]
EventAdapter: TypeAdapter[Any] = TypeAdapter(Event)


def make_event(type_name: str, *, task_id: str, seq: int, payload: dict[str, Any]) -> _Envelope:
    """Build and validate an event. Raises ValidationError on bad payload."""
    if type_name not in EVENT_MODELS:
        raise ValueError(f"unknown event type: {type_name}")
    return EventAdapter.validate_python(
        {"type": type_name, "task_id": task_id, "seq": seq, "payload": payload}
    )


def parse_event(data: str | bytes | dict[str, Any]) -> _Envelope:
    if isinstance(data, (str, bytes)):
        return EventAdapter.validate_json(data)
    return EventAdapter.validate_python(data)
