"""What shape of question is this? (Q.2 / Q.5). Pure functions, no model.

single  -> one research branch (a 3B planner over-branches simple facts: measured 3 branches for
           "who is X" questions in the P3 matrix)
compare -> one research branch per item, items parsed from the prompt when it lists them
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_MULTI = re.compile(
    r"\b(compare|comparing|comparison|versus|vs\.?|difference between|differences between)\b"
    r"|\bwhich\b[^?]*\bor\b"
    r"|\bboth\b",
    re.I,
)
_LIST = re.compile(r"\b(?:compare|between)\s+(?:the\s+)?(?P<body>.+?)[?.!]*$", re.I)
_ATTR = re.compile(r"^(?P<attr>[\w\s'-]+?)\s+of\s+(?P<items>.+)$", re.I)
_TAIL = re.compile(r"\s+(?:in|for|by|as of|using|when|on)\s+[\w\s-]+$", re.I)
_SPLIT = re.compile(r"\s*,\s*(?:and\s+|or\s+)?|\s+(?:and|or|vs\.?|versus)\s+", re.I)
_ARTICLE = re.compile(r"^(?:the|a|an)\s+", re.I)


@dataclass(frozen=True)
class Shape:
    kind: str  # "single" | "multi"
    attr: str  # "heights" | "" (unknown)
    items: tuple[str, ...]  # parsed items (may be empty for multi questions we cannot parse)


def shape(prompt: str) -> Shape:
    p = prompt.strip()
    if not _MULTI.search(p):
        return Shape("single", "", ())
    m = _LIST.search(p)
    if not m:
        return Shape("multi", "", ())
    body = _TAIL.sub("", m.group("body").strip())
    attr = ""
    am = _ATTR.match(body)
    if am:
        attr, body = am.group("attr").strip(), am.group("items")
    items = [_ARTICLE.sub("", x.strip()).strip(" .?!") for x in _SPLIT.split(body)]
    items = [x for x in items if len(x) >= 2][:4]
    return Shape("multi", attr, tuple(items) if len(items) >= 2 else ())


def item_query(attr: str, item: str) -> str:
    """'heights', 'Mount Everest' -> 'Mount Everest height' (short web query, singular attr)."""
    a = re.sub(r"(?<=[a-z])s\b", "", attr.lower()).strip() if attr else ""
    return f"{item} {a}".strip()
