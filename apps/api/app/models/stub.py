"""Deterministic stand-in model for tests and e2e (LLM_PROVIDER=stub). Never the default.

It answers only from the material the agents put in the prompt (the SOURCES block),
so it exercises the same grounding path as a real model. Metrics are synthetic and
labelled model="stub".
"""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any

from pos_schemas import ModelProfile

from .base import LLMResult, Message, Metrics

_SRC = re.compile(r"^\[(\d+)\] ([a-z]+://\S+)\n(?:TITLE: (.*)\n)?TEXT: (.*)$", re.MULTILINE)


def _sources(text: str) -> list[dict[str, str]]:
    return [{"n": n, "url": u, "title": t or "", "text": x} for n, u, t, x in _SRC.findall(text)]


def _compare_items(task: str) -> list[str]:
    m = re.search(r"\b(?:compare|between)\s+(.+?)[?.!]*$", task, re.I)
    if not m:
        return []
    parts = re.split(r",\s*(?:and\s+)?|\s+and\s+", m.group(1))
    return [p.strip() for p in parts if len(p.strip()) >= 2][:4]


def _first_sentence(text: str) -> str:
    m = re.match(r"(.+?[.!?])(\s|$)", text.strip())
    return (m.group(1) if m else text.strip())[:400]


class StubClient:
    name = "stub"

    def __init__(self, delay_s: float = 0.0) -> None:
        self._delay = delay_s

    async def generate(
        self, profile: ModelProfile, messages: list[Message], schema: dict[str, Any]
    ) -> LLMResult:
        if self._delay:
            await asyncio.sleep(self._delay)
        title = schema.get("title", "")
        user = messages[-1].content
        if title == "Plan":
            task = re.search(r"TASK: (.*)", user)
            q = (task.group(1) if task else user)[:200].strip() or "query"
            items = _compare_items(q)
            if len(items) >= 2:  # "Compare A, B and C" -> one independent research branch each
                ids = [f"r{i}" for i in range(1, len(items) + 1)]
                steps: list[dict[str, Any]] = [
                    {
                        "id": rid,
                        "agent_id": "research",
                        "goal": f"Facts about {it}",
                        "query": it[:200],
                    }
                    for rid, it in zip(ids, items, strict=True)
                ]
                steps += [
                    {"id": "w", "agent_id": "writer", "goal": "Compare", "depends_on": ids},
                    {"id": "v", "agent_id": "validator", "goal": "Check", "depends_on": ["w"]},
                ]
            else:
                steps = [
                    {"agent_id": "research", "goal": "Find and read sources"},
                    {"agent_id": "writer", "goal": "Answer with citations"},
                    {"agent_id": "validator", "goal": "Check grounding"},
                ]
            out: dict[str, Any] = {"search_query": q if len(q) >= 2 else q + " ?", "steps": steps}
        elif title == "ResearchResult":
            src = _sources(user)
            out = {
                "summary": " ".join(_first_sentence(s["text"]) for s in src[:2]),
                "sources": [
                    {"url": s["url"], "title": s["title"], "snippet": _first_sentence(s["text"])}
                    for s in src[:2]
                ],
                "confidence": 0.9 if src else 0.0,
            }
        elif title == "Draft":
            src = _sources(user)
            if src:
                out = {
                    "answer": f"{_first_sentence(src[0]['text'])} [1]",
                    "citations": [1],
                }
            else:
                out = {"answer": "I could not verify this.", "citations": []}
        else:
            out = {}
        text = json.dumps(out)
        n_out = max(1, len(text) // 4)
        return LLMResult(
            text=text,
            metrics=Metrics(
                model="stub",
                ttft_ms=int(self._delay * 1000 * 0.3) + 12,
                tok_s=42.0,
                total_ms=int(self._delay * 1000) + 20,
                prompt_tokens=sum(len(m.content) for m in messages) // 4,
                completion_tokens=n_out,
            ),
        )
