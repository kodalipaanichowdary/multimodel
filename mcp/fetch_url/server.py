"""MCP server: fetch_url — readable text from a public web page.

Safety: http(s) only; every hop (incl. redirects) must resolve to a public address;
5 redirects max; 2 MB download cap; 15 s timeout; HTML/plain text only.

FETCH_PROVIDER = live (default) | stub (tests: mcp/_stub/corpus.json)
Run standalone over stdio:  python mcp/fetch_url/server.py
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import os
import re
import socket
from html import unescape
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx
from mcp.server.fastmcp import FastMCP

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) PersonalAIOS/0.2 (+local research agent)"
MAX_BYTES = 2_000_000
MAX_REDIRECTS = 5
TIMEOUT = httpx.Timeout(15.0, connect=6.0)
STUB = Path(__file__).resolve().parents[1] / "_stub" / "corpus.json"


class FetchError(Exception):
    pass


_SKIP = {
    "script",
    "style",
    "noscript",
    "svg",
    "template",
    "iframe",
    "head",
    "nav",
    "footer",
    "form",
    "button",
}
_BLOCK = {
    "p",
    "div",
    "li",
    "tr",
    "br",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "section",
    "article",
    "table",
    "td",
    "th",
    "dd",
    "dt",
    "caption",
}


class _Text(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.title = ""
        self._skip = 0
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: Any) -> None:
        if tag == "title":
            self._in_title = True
        if tag in _SKIP:
            self._skip += 1
        if tag in _BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False
        if tag in _SKIP and self._skip:
            self._skip -= 1
        if tag in _BLOCK:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title += data
        elif not self._skip:
            self.parts.append(data)


def html_to_text(html: str) -> tuple[str, str]:
    p = _Text()
    p.feed(html)
    text = unescape("".join(p.parts))
    text = re.sub(r"\[\d+\]|\[edit\]", "", text)  # wiki footnote markers
    lines = [re.sub(r"[ \t\u00a0]+", " ", ln).strip() for ln in text.splitlines()]
    text = "\n".join(ln for ln in lines if ln)
    return re.sub(r"\s+", " ", p.title).strip(), text


def _is_public(host: str) -> bool:
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as e:
        raise FetchError(f"cannot resolve {host}") from e
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            return False
    return True


async def check_url(url: str) -> None:
    u = urlparse(url)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise FetchError(f"only http(s) URLs are allowed: {url!r}")
    if not await asyncio.to_thread(_is_public, u.hostname):
        raise FetchError(f"blocked non-public address: {u.hostname}")


def _stub(url: str, max_chars: int) -> dict[str, Any]:
    for d in json.loads(STUB.read_text(encoding="utf-8"))["docs"]:
        if d["url"] == url:
            return {
                "url": url,
                "final_url": url,
                "status": 200,
                "title": d["title"],
                "text": d["text"][:max_chars],
                "truncated": False,
            }
    raise FetchError(f"stub corpus has no page {url}")


async def fetch_url(url: str, max_chars: int = 20000) -> dict[str, Any]:
    """Fetch a public page; returns {url, final_url, status, title, text, truncated}."""
    max_chars = max(500, min(int(max_chars), 50000))
    if os.getenv("FETCH_PROVIDER", "live").lower() == "stub":
        return _stub(url, max_chars)
    current = url
    async with httpx.AsyncClient(
        timeout=TIMEOUT, headers={"User-Agent": UA}, follow_redirects=False
    ) as http:
        for _ in range(MAX_REDIRECTS + 1):
            await check_url(current)
            async with http.stream("GET", current) as r:
                if r.status_code in (301, 302, 303, 307, 308) and "location" in r.headers:
                    current = urljoin(current, r.headers["location"])
                    continue
                if r.status_code >= 400:
                    raise FetchError(f"HTTP {r.status_code} for {current}")
                ctype = r.headers.get("content-type", "").split(";")[0].strip().lower()
                if ctype not in ("text/html", "application/xhtml+xml", "text/plain", ""):
                    raise FetchError(f"unsupported content-type {ctype!r}")
                body = bytearray()
                async for chunk in r.aiter_bytes():
                    body += chunk
                    if len(body) > MAX_BYTES:
                        raise FetchError(f"page larger than {MAX_BYTES} bytes")
                raw = body.decode(r.encoding or "utf-8", errors="replace")
                title, text = html_to_text(raw) if ctype != "text/plain" else ("", raw)
                return {
                    "url": url,
                    "final_url": current,
                    "status": r.status_code,
                    "title": title,
                    "text": text[:max_chars],
                    "truncated": len(text) > max_chars,
                }
    raise FetchError(f"more than {MAX_REDIRECTS} redirects")


server = FastMCP("fetch_url")


@server.tool(name="fetch_url", description="Fetch a public web page and return its readable text.")
async def _fetch_url_tool(url: str, max_chars: int = 20000) -> dict[str, Any]:
    return await fetch_url(url, max_chars)


if __name__ == "__main__":
    server.run()
