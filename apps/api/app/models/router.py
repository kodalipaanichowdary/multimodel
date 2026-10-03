"""Model router (G3.11): pick local or cloud per call from the task's privacy flag + call kind.

Policy (deterministic, no model involved):
  private task            -> local, always (never leaves the machine)
  offline (POS_OFFLINE=1) -> local, always
  cloud unavailable       -> local (no key = adapter disabled)
  otherwise               -> CLOUD_KINDS decides per kind (default: none -> everything local)

The run's privacy flag travels in a context variable set by the executor, so every model call
of that task (including parallel branches) sees it without changing the LLMClient interface.
"""

from __future__ import annotations

from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Literal

from pos_schemas import ModelProfile

from .base import LLMClient, LLMResult, Message

Kind = Literal["plan", "research", "write", "other"]
KIND_BY_AGENT = {"orchestrator": "plan", "research": "research", "writer": "write"}

# per-run routing context: (private, kind) ; kind is set per call
run_private: ContextVar[bool] = ContextVar("run_private", default=True)
call_kind: ContextVar[str] = ContextVar("call_kind", default="other")


@dataclass(frozen=True)
class Decision:
    target: Literal["local", "cloud"]
    reason: str


class ModelRouter:
    name = "router"

    def __init__(
        self, local: LLMClient, cloud: Any | None, *, cloud_kinds: frozenset[str], offline: bool
    ) -> None:
        self.local = local
        self.cloud = cloud
        self.cloud_kinds = cloud_kinds
        self.offline = offline
        self.decisions: list[Decision] = []

    def decide(self, private: bool, kind: str) -> Decision:
        if private:
            return Decision("local", "private task: local only")
        if self.offline:
            return Decision("local", "offline: local only")
        if self.cloud is None or not getattr(self.cloud, "available", False):
            return Decision("local", "cloud adapter disabled (no CLOUD_API_KEY)")
        if kind in self.cloud_kinds:
            return Decision("cloud", f"policy: {kind} -> cloud")
        return Decision("local", f"policy: {kind} -> local")

    async def generate(
        self, profile: ModelProfile, messages: list[Message], schema: dict[str, Any]
    ) -> LLMResult:
        d = self.decide(run_private.get(), call_kind.get())
        self.decisions.append(d)
        client = self.cloud if d.target == "cloud" else self.local
        return await client.generate(profile, messages, schema)
