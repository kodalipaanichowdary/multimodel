"""Pick the parts of a fetched page worth sending to a small model (token budget)."""

from __future__ import annotations

import re

_TOKEN = re.compile(r"[a-z0-9à-ɏ]+")
_STOP = {
    "the",
    "a",
    "an",
    "of",
    "is",
    "are",
    "was",
    "who",
    "what",
    "which",
    "when",
    "where",
    "how",
    "in",
    "on",
    "for",
    "to",
    "and",
    "or",
    "do",
    "does",
    "did",
    "current",
    "currently",
    "now",
    "today",
}


def terms(text: str) -> set[str]:
    return {t for t in _TOKEN.findall(text.lower()) if t not in _STOP and len(t) > 1}


def select(text: str, query: str, budget: int = 1600) -> str:
    """Highest-overlap lines (kept in page order) until `budget` chars. Single line output."""
    q = terms(query)
    lines = [ln.strip() for ln in text.splitlines() if len(ln.strip()) > 2]
    if not lines:
        return ""
    scored = sorted(
        range(len(lines)),
        key=lambda i: (-len(q & terms(lines[i])), i),
    )
    keep: set[int] = set()
    used = 0
    for i in scored:
        if used >= budget:
            break
        if q and not (q & terms(lines[i])) and keep:
            break  # only relevant lines once we have some
        keep.add(i)
        used += len(lines[i]) + 3
    out = " | ".join(lines[i] for i in sorted(keep))
    return re.sub(r"\s+", " ", out)[:budget]
