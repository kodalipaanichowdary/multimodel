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


# Instruction-like text inside fetched pages. Pages are DATA: anything that addresses the model,
# asks for a tool, a file, a command, or a role change is removed before a prompt is built.
INJECTION = re.compile(
    r"(ignore|disregard|forget|override)\b.{0,40}\b(instructions?|prompts?|rules|guidelines|above|previous)"
    r"|\b(system|developer)\s*(prompt|message|instructions?)\b"
    r"|\byou are (now|no longer|an?)\b"
    r"|\b(act|behave|respond|reply|answer) (as|like|only)\b"
    r"|\b(call|invoke|use|run|execute) (the )?(tool|function|command|shell|terminal|fs_write|web_search|fetch_url)\b"
    r"|\b(write|save|create|delete|overwrite) (a |the |this )?(file|files)\b"
    r"|\bfs_write\b|\bterminal\.exec\b|\bapproval\b.{0,20}\b(grant|allow|skip)"
    r"|\b(rm -rf|curl |wget |powershell|cmd\.exe|sudo )",
    re.I,
)
_PIECES = re.compile(r"(?<=[.!?])\s+|\s+\|\s+|\n+")


def strip_instructions(text: str) -> tuple[str, int]:
    """Drop sentences/lines that look like instructions to the model. Returns (clean, removed)."""
    kept, removed = [], 0
    for line in text.splitlines():
        parts = [p for p in _PIECES.split(line) if p.strip()]
        good = [p for p in parts if not INJECTION.search(p)]
        removed += len(parts) - len(good)
        if good:
            kept.append(" ".join(good))
    return "\n".join(kept), removed


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
