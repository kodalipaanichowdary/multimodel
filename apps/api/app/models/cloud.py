"""Cloud adapter (OpenAI-compatible /chat/completions). Present, but DISABLED without a key.

Never used for private tasks or in offline mode (the router enforces that). No key is shipped
or needed for anything in this repo; set CLOUD_API_KEY / CLOUD_BASE_URL / CLOUD_MODEL to enable.
"""

from __future__ import annotations

import json
import time
from typing import Any

import httpx
from pos_schemas import ModelProfile

from .base import LLMError, LLMResult, Message, Metrics


class CloudClient:
    name = "cloud"

    def __init__(self, api_key: str | None, base_url: str, model: str) -> None:
        self._key = api_key or None
        self._base = base_url.rstrip("/")
        self.model = model

    @property
    def available(self) -> bool:
        return self._key is not None

    async def generate(
        self, profile: ModelProfile, messages: list[Message], schema: dict[str, Any]
    ) -> LLMResult:
        if not self.available:
            raise LLMError("cloud adapter disabled: no CLOUD_API_KEY")
        body = {
            "model": self.model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "temperature": profile.temperature,
            "max_tokens": profile.max_tokens,
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": schema.get("title", "out"), "schema": schema},
            },
        }
        t0 = time.perf_counter()
        try:
            async with httpx.AsyncClient(timeout=60) as http:
                r = await http.post(
                    f"{self._base}/chat/completions",
                    json=body,
                    headers={"Authorization": f"Bearer {self._key}"},
                )
                r.raise_for_status()
                data = r.json()
        except httpx.HTTPError as e:
            raise LLMError(f"cloud request failed: {type(e).__name__}") from e
        total = time.perf_counter() - t0
        usage = data.get("usage", {})
        out = usage.get("completion_tokens", 0)
        return LLMResult(
            text=data["choices"][0]["message"]["content"] or json.dumps({}),
            metrics=Metrics(
                model=f"cloud:{self.model}",
                ttft_ms=round(total * 1000),  # non-streamed: first token == full reply
                tok_s=round(out / total, 2) if total else 0.0,
                total_ms=round(total * 1000),
                prompt_tokens=usage.get("prompt_tokens", 0),
                completion_tokens=out,
            ),
        )
