"""Embeddings via Ollama (nomic-embed-text). Used by the memory layer; optional (FTS5 fallback)."""

from __future__ import annotations

import httpx


class OllamaEmbedder:
    def __init__(
        self, base_url: str = "http://127.0.0.1:11434", model: str = "nomic-embed-text"
    ) -> None:
        self._base = base_url.rstrip("/")
        self.model = model

    async def __call__(self, texts: list[str]) -> list[list[float]]:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=3.0)) as http:
            r = await http.post(
                f"{self._base}/api/embed",
                json={"model": self.model, "input": texts, "keep_alive": "10m"},
            )
            r.raise_for_status()
            return r.json()["embeddings"]
