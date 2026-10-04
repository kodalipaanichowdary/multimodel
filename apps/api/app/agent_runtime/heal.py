"""The one place model output becomes a typed value.

validate -> on ValidationError, append the exact e.errors() and retry once -> else fallback.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Generic, TypeVar

from pos_schemas import ModelProfile
from pydantic import BaseModel, ValidationError

from ..models.base import LLMClient, Message, Metrics

T = TypeVar("T", bound=BaseModel)
log = logging.getLogger("pos.heal")

MAX_ATTEMPTS = 2  # first try + one healing retry

OnAttempt = Callable[[int, Metrics], Awaitable[None]]


@dataclass
class Healed(Generic[T]):
    value: T
    attempts: int
    healed: bool  # first attempt invalid, retry valid
    fell_back: bool  # both invalid -> fallback payload
    errors: list[list[dict[str, Any]]] = field(
        default_factory=list
    )  # e.errors() per failed attempt
    metrics: list[Metrics] = field(default_factory=list)


def error_feedback(e: ValidationError) -> str:
    errs = e.errors(include_url=False, include_context=False)
    return (
        "Your previous reply failed validation. Exact errors (pydantic ValidationError.errors()):\n"
        f"{json.dumps(errs, default=str)}\n"
        "Reply again with ONLY corrected JSON that satisfies the schema."
    )


async def generate_typed(
    client: LLMClient,
    profile: ModelProfile,
    messages: list[Message],
    model_cls: type[T],
    fallback: Callable[[], T],
    *,
    schema: dict[str, Any] | None = None,
    context: dict[str, Any] | None = None,
    on_attempt: OnAttempt | None = None,
    repair: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
) -> Healed[T]:
    """`repair` (optional): deterministic fix-up of the parsed JSON object before validation
    (e.g. assign missing plan step ids). It may only restructure; the schema still decides."""
    schema = schema or model_cls.model_json_schema()
    convo = list(messages)
    errors: list[list[dict[str, Any]]] = []
    metrics: list[Metrics] = []
    for attempt in range(1, MAX_ATTEMPTS + 1):
        res = await client.generate(profile, convo, schema)
        metrics.append(res.metrics)
        if on_attempt:
            await on_attempt(attempt, res.metrics)
        try:
            text = res.text
            if repair is not None:
                try:
                    obj = json.loads(text)
                except json.JSONDecodeError:
                    obj = None
                if isinstance(obj, dict):
                    text = json.dumps(repair(obj))
            value = model_cls.model_validate_json(text, context=context)
        except ValidationError as e:
            errors.append(e.errors(include_url=False, include_context=False))
            log.warning(
                "%s attempt %d invalid: %s | output: %.300s",
                model_cls.__name__,
                attempt,
                json.dumps(errors[-1], default=str)[:600],
                res.text,
            )
            convo = [*convo, Message("assistant", res.text), Message("user", error_feedback(e))]
            continue
        return Healed(
            value, attempt, healed=attempt > 1, fell_back=False, errors=errors, metrics=metrics
        )
    return Healed(
        fallback(), MAX_ATTEMPTS, healed=False, fell_back=True, errors=errors, metrics=metrics
    )
