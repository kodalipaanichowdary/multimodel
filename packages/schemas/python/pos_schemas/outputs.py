"""Typed agent outputs (P2). Mirrored 1:1 by packages/schemas/ts/src/outputs.ts.

Every model call is parsed into one of these. Semantic checks that need run state
(e.g. "this URL was actually fetched") read it from the pydantic validation context:
    Model.model_validate_json(text, context={"fetched_urls": {...}, "n_sources": 3})
"""

from __future__ import annotations

import re

from pydantic import BaseModel, ConfigDict, Field, StrictBool, ValidationInfo, field_validator

from .events import PlanStep

_URL = r"^https?://[^\s]+$"
_CITE = re.compile(r"\[(\d+)\]")


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Plan(_Strict):
    search_query: str = Field(min_length=2, max_length=200, description="web search query")
    steps: list[PlanStep] = Field(min_length=1, max_length=8)

    @field_validator("steps")
    @classmethod
    def _known_agents(cls, v: list[PlanStep], info: ValidationInfo) -> list[PlanStep]:
        allowed = (info.context or {}).get("allowed_agents")
        if allowed is not None:
            bad = sorted({s.agent_id for s in v} - set(allowed))
            if bad:
                raise ValueError(f"unknown agent_id {bad}; allowed: {sorted(allowed)}")
        return v


class Source(_Strict):
    url: str = Field(pattern=_URL, max_length=2000)
    title: str = Field(default="", max_length=300)
    snippet: str = Field(default="", max_length=1000)


class ResearchResult(_Strict):
    summary: str = Field(max_length=3000)
    sources: list[Source] = Field(max_length=10)
    confidence: float = Field(ge=0, le=1)

    @field_validator("sources")
    @classmethod
    def _only_fetched(cls, v: list[Source], info: ValidationInfo) -> list[Source]:
        fetched = (info.context or {}).get("fetched_urls")
        if fetched is not None:
            bad = [s.url for s in v if s.url not in fetched]
            if bad:
                raise ValueError(f"sources must be fetched URLs only; not fetched: {bad}")
        return v


class Draft(_Strict):
    answer: str = Field(min_length=1, max_length=4000)
    citations: list[str] = Field(max_length=10, description="URLs, in [n] order")

    @field_validator("citations")
    @classmethod
    def _cited_urls(cls, v: list[str], info: ValidationInfo) -> list[str]:
        for u in v:
            if not re.match(_URL, u):
                raise ValueError(f"citation is not an http(s) URL: {u!r}")
        allowed = (info.context or {}).get("source_urls")
        if allowed is not None:
            bad = [u for u in v if u not in allowed]
            if bad:
                raise ValueError(f"citations must be source URLs; unknown: {bad}")
        return v

    @field_validator("answer")
    @classmethod
    def _markers_in_range(cls, v: str, info: ValidationInfo) -> str:
        n = (info.context or {}).get("n_sources")
        if n is not None:
            out = sorted({int(m) for m in _CITE.findall(v) if not 1 <= int(m) <= n})
            if out:
                raise ValueError(f"citation markers out of range 1..{n}: {out}")
        return v


class Verdict(_Strict):
    passed: StrictBool
    issues: list[str] = Field(default_factory=list, max_length=50)
