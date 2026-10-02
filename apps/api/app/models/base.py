"""Model gateway contract. Agents only ever see LLMClient; providers are swappable."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Protocol

from pos_schemas import ModelProfile


@dataclass(frozen=True)
class Message:
    role: Literal["system", "user", "assistant"]
    content: str


@dataclass(frozen=True)
class Metrics:
    model: str
    ttft_ms: int
    tok_s: float
    total_ms: int
    prompt_tokens: int
    completion_tokens: int


@dataclass(frozen=True)
class LLMResult:
    text: str
    metrics: Metrics


class LLMError(RuntimeError):
    """Provider unreachable / model missing / bad response. Not a validation problem."""


class LLMClient(Protocol):
    name: str

    async def generate(
        self, profile: ModelProfile, messages: list[Message], schema: dict[str, Any]
    ) -> LLMResult:
        """One completion constrained to `schema` (JSON Schema). Raises LLMError."""
        ...
