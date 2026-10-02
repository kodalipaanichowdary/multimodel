"""Ollama /api/chat, streamed so time-to-first-token is measured, not estimated."""

from __future__ import annotations

import json
import time
from typing import Any

import httpx
from pos_schemas import ModelProfile

from .base import LLMError, LLMResult, Message, Metrics


class OllamaClient:
    name = "ollama"

    def __init__(self, base_url: str = "http://127.0.0.1:11434", timeout_s: float = 180.0) -> None:
        self._base = base_url.rstrip("/")
        self._timeout = httpx.Timeout(timeout_s, connect=5.0)

    async def generate(
        self, profile: ModelProfile, messages: list[Message], schema: dict[str, Any]
    ) -> LLMResult:
        body = {
            "model": profile.model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "stream": True,
            "format": schema,  # grammar-constrained JSON
            "options": {
                "temperature": profile.temperature,
                "num_predict": profile.max_tokens,
                "seed": 0,
                "num_ctx": 8192,
            },
            "keep_alive": "10m",
        }
        t0 = time.perf_counter()
        ttft: float | None = None
        parts: list[str] = []
        final: dict[str, Any] = {}
        try:
            async with (
                httpx.AsyncClient(timeout=self._timeout) as http,
                http.stream("POST", f"{self._base}/api/chat", json=body) as resp,
            ):
                if resp.status_code != 200:
                    detail = (await resp.aread()).decode(errors="replace")[:300]
                    raise LLMError(f"ollama {resp.status_code} for {profile.model}: {detail}")
                async for line in resp.aiter_lines():
                    if not line.strip():
                        continue
                    chunk = json.loads(line)
                    if "error" in chunk:
                        raise LLMError(f"ollama error for {profile.model}: {chunk['error']}")
                    piece = chunk.get("message", {}).get("content", "")
                    if piece and ttft is None:
                        ttft = time.perf_counter() - t0
                    parts.append(piece)
                    if chunk.get("done"):
                        final = chunk
        except httpx.HTTPError as e:
            raise LLMError(f"ollama unreachable at {self._base}: {type(e).__name__}: {e}") from e
        total = time.perf_counter() - t0
        eval_count = int(final.get("eval_count", 0))
        eval_ns = int(final.get("eval_duration", 0))
        return LLMResult(
            text="".join(parts),
            metrics=Metrics(
                model=profile.model,
                ttft_ms=round((ttft if ttft is not None else total) * 1000),
                tok_s=round(eval_count / (eval_ns / 1e9), 2) if eval_ns else 0.0,
                total_ms=round(total * 1000),
                prompt_tokens=int(final.get("prompt_eval_count", 0)),
                completion_tokens=eval_count,
            ),
        )

    async def list_models(self) -> list[str]:
        try:
            async with httpx.AsyncClient(timeout=5.0) as http:
                r = await http.get(f"{self._base}/api/tags")
                r.raise_for_status()
                return [m["name"] for m in r.json().get("models", [])]
        except httpx.HTTPError as e:
            raise LLMError(f"ollama unreachable at {self._base}: {e}") from e
