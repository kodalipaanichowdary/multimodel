"""MCP server: web_search. Keyless providers, no API keys.

SEARCH_PROVIDER = auto (default: DuckDuckGo HTML, topped up from Wikipedia) | ddg | wikipedia
                | stub (tests: mcp/_stub/corpus.json) | empty (tests: always no results)

Run standalone over stdio:  python mcp/web_search/server.py
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from html import unescape
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, urlparse

import httpx
from mcp.server.fastmcp import FastMCP

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) PersonalAIOS/0.2 (+local research agent)"
TIMEOUT = httpx.Timeout(12.0, connect=6.0)
STUB = Path(__file__).resolve().parents[1] / "_stub" / "corpus.json"


def _clean(s: str) -> str:
    return re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", "", s))).strip()


class _DDGParser(HTMLParser):
    """html.duckduckgo.com result list: a.result__a (title/link) + .result__snippet."""

    def __init__(self) -> None:
        super().__init__()
        self.results: list[dict[str, str]] = []
        self._field: str | None = None
        self._buf: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = dict(attrs)
        cls = a.get("class") or ""
        if tag == "a" and "result__a" in cls:
            self.results.append(
                {"url": _ddg_target(a.get("href") or ""), "title": "", "snippet": ""}
            )
            self._field, self._buf = "title", []
        elif "result__snippet" in cls and self.results:
            self._field, self._buf = "snippet", []

    def handle_endtag(self, tag: str) -> None:
        if self._field and tag in ("a", "td", "div"):
            self.results[-1][self._field] = _clean("".join(self._buf))
            self._field = None

    def handle_data(self, data: str) -> None:
        if self._field:
            self._buf.append(data)


def _ddg_target(href: str) -> str:
    if href.startswith("//"):
        href = "https:" + href
    q = parse_qs(urlparse(href).query)
    return q["uddg"][0] if "uddg" in q else href


def parse_ddg(html: str) -> list[dict[str, str]]:
    p = _DDGParser()
    p.feed(html)
    out = []
    for r in p.results:
        host = urlparse(r["url"]).netloc
        if r["url"].startswith("http") and "duckduckgo.com" not in host:  # drop ads / internal
            out.append(r)
    return out


async def _ddg(query: str, k: int) -> list[dict[str, str]]:
    async with httpx.AsyncClient(
        timeout=TIMEOUT, headers={"User-Agent": UA}, follow_redirects=True
    ) as http:
        r = await http.post("https://html.duckduckgo.com/html/", data={"q": query})
        r.raise_for_status()
        return parse_ddg(r.text)[:k]


def parse_wikipedia(data: dict[str, Any]) -> list[dict[str, str]]:
    return [
        {
            "url": "https://en.wikipedia.org/wiki/" + quote(h["title"].replace(" ", "_")),
            "title": h["title"],
            "snippet": _clean(h.get("snippet", "")),
        }
        for h in data.get("query", {}).get("search", [])
    ]


async def _wikipedia(query: str, k: int) -> list[dict[str, str]]:
    params = {
        "action": "query",
        "list": "search",
        "srsearch": query,
        "format": "json",
        "srlimit": str(k),
    }
    async with httpx.AsyncClient(timeout=TIMEOUT, headers={"User-Agent": UA}) as http:
        r = await http.get("https://en.wikipedia.org/w/api.php", params=params)
        r.raise_for_status()
        return parse_wikipedia(r.json())[:k]


def _stub(query: str, k: int) -> list[dict[str, str]]:
    if "zzz-no-results" in query.lower():
        return []
    docs = json.loads(STUB.read_text(encoding="utf-8"))["docs"]
    # rank by query-term overlap so branches with different queries get different pages;
    # a query matching nothing gets the whole corpus (keeps generic test prompts working)
    terms = {t for t in re.findall(r"[a-z0-9]+", query.lower()) if len(t) >= 4}

    def score(d: dict) -> int:
        hay = f"{d['title']} {d['text']}".lower()
        return sum(t in hay for t in terms)

    hits = sorted((d for d in docs if score(d)), key=score, reverse=True) or docs
    return [{"url": d["url"], "title": d["title"], "snippet": d["text"][:160]} for d in hits][:k]


async def web_search(query: str, k: int = 5) -> dict[str, Any]:
    """Search the web. Returns {query, provider, results: [{url, title, snippet}], errors}."""
    query = query.strip()[:300]
    k = max(1, min(int(k), 10))
    provider = os.getenv("SEARCH_PROVIDER", "auto").lower()
    errors: list[str] = []
    results: list[dict[str, str]] = []
    if provider == "empty":
        pass
    elif provider == "stub":
        await asyncio.sleep(float(os.getenv("STUB_TOOL_DELAY_S", "0")))  # simulated network latency
        results = _stub(query, k)
    else:
        chain = {"auto": ["ddg", "wikipedia"], "ddg": ["ddg"], "wikipedia": ["wikipedia"]}.get(
            provider, ["ddg", "wikipedia"]
        )
        for name in chain:
            if len(results) >= min(k, 3):
                break
            try:
                got = await (_ddg if name == "ddg" else _wikipedia)(query, k)
            except Exception as e:  # provider down / blocked: try the next one
                errors.append(f"{name}: {type(e).__name__}: {e}"[:200])
                continue
            seen = {r["url"] for r in results}
            results += [r for r in got if r["url"] not in seen]
    return {"query": query, "provider": provider, "results": results[:k], "errors": errors}


server = FastMCP("web_search")


@server.tool(
    name="web_search", description="Keyless web search. Returns result URLs, titles and snippets."
)
async def _web_search_tool(query: str, k: int = 5) -> dict[str, Any]:
    return await web_search(query, k)


if __name__ == "__main__":
    server.run()
