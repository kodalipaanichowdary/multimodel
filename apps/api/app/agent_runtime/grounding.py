"""Grounding guard (Validator). Pure functions, no model.

A fetched page is a Page(n, url, title, text). The Writer's Draft must cite pages with
[n] markers. For every sentence:
  - it must carry at least one valid [n] (hedges like "could not verify" are exempt);
  - its key terms (names, numbers, dates) must appear in the text of the page(s) it cites.
Anything else is a claim that did not come from the fetched sources.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from pos_schemas import Draft, Verdict

CITE = re.compile(r"\[(\d+)\]")
_SENT = re.compile(r"(?<=[.!?])\s+(?=\S)|(?<=\])\s+(?=[A-Z])")
_WORD = re.compile(r"[A-Za-z\u00c0-\u024f][\w\u00c0-\u024f'\u2019.-]*|\d[\d,.:/-]*")
HEDGE = re.compile(
    r"\b(could not|cannot|can't|unable to) (be )?(verify|verified|confirm|find)\b", re.I
)
MIN_SUPPORT = 0.75

# capitalised words that carry no claim on their own
_STOP = {
    "the",
    "a",
    "an",
    "this",
    "that",
    "these",
    "those",
    "it",
    "its",
    "he",
    "she",
    "they",
    "his",
    "her",
    "their",
    "there",
    "as",
    "in",
    "on",
    "at",
    "of",
    "for",
    "from",
    "by",
    "with",
    "and",
    "or",
    "but",
    "according",
    "currently",
    "today",
    "since",
    "also",
    "however",
    "yes",
    "no",
    "i",
    "we",
    "you",
    "is",
    "was",
    "are",
    "were",
    "be",
    "been",
    "has",
    "have",
    "had",
    "who",
    "what",
    "which",
    "when",
    "where",
    "source",
    "sources",
    "answer",
    "based",
    "per",
    "mr",
    "mrs",
    "ms",
    "dr",
    "sri",
    "shri",
}


@dataclass(frozen=True)
class Page:
    n: int
    url: str
    title: str
    text: str


_ONLY_MARKS = re.compile(r"^(\s*\[\d+\][\s.,;]*)+$")


def sentences(text: str) -> list[str]:
    out: list[str] = []
    for s in (p.strip() for p in _SENT.split(text.strip())):
        if not s:
            continue
        if out and _ONLY_MARKS.match(s):  # "... 2024. [1]" -> marker belongs to the sentence before
            out[-1] = f"{out[-1]} {s}"
        else:
            out.append(s)
    return out


def key_terms(sentence: str) -> list[str]:
    """Proper-noun-like words and numbers: the parts of a sentence that make it a specific claim."""
    plain = CITE.sub(" ", sentence)
    out = []
    for w in _WORD.findall(plain):
        w = w.strip(".,:;-'\u2019")
        if not w:
            continue
        if w[0].isdigit():
            if len(w) >= 2 or w.isdigit():
                out.append(w)
        elif w[0].isupper() and w.lower() not in _STOP and len(w) > 1:
            out.append(w)
    return out


def _found(term: str, haystack: str) -> bool:
    if term[0].isdigit():
        return term in haystack
    return re.search(rf"(?<![\w]){re.escape(term.lower())}(?![\w])", haystack) is not None


def check(draft: Draft, pages: list[Page]) -> Verdict:
    by_n = {p.n: p for p in pages}
    issues: list[str] = []
    grounded = 0
    for i, s in enumerate(sentences(draft.answer), 1):
        marks = [int(m) for m in CITE.findall(s)]
        if not marks:
            if HEDGE.search(s):
                continue
            issues.append(f"sentence {i} has no [n] citation: {s[:120]!r}")
            continue
        bad = [m for m in marks if m not in by_n]
        if bad:
            issues.append(f"sentence {i} cites unknown source(s) {bad}")
            continue
        text = " ".join(by_n[m].title + " " + by_n[m].text for m in marks).lower()
        terms = key_terms(s)
        if terms:
            hit = [t for t in terms if _found(t, text)]
            missing = [t for t in terms if t not in hit]
            numbers_missing = [t for t in missing if t[0].isdigit()]
            if numbers_missing or len(hit) / len(terms) < MIN_SUPPORT:
                issues.append(
                    f"sentence {i} not supported by cited source(s) {marks}: missing {missing[:6]}"
                )
                continue
        grounded += 1
    if not issues and grounded == 0 and not HEDGE.search(draft.answer):
        issues.append("no sentence is grounded in a cited source")
    return Verdict(passed=not issues, issues=issues)


def _fully_supported_by(terms: list[str], page: Page) -> bool:
    text = (page.title + " " + page.text).lower()
    return bool(terms) and all(_found(t, text) for t in terms)


def align(draft: Draft, pages: list[Page]) -> tuple[Draft, list[str]]:
    """Re-point a sentence's [n] marker to the fetched source that contains ALL of its key terms.

    Only for sentences that are uncited or not supported by what they cite. Never invents
    support: a sentence whose terms are not all in one fetched page is left as is (check() fails it).
    Returns the aligned draft and a note per change.
    """
    by_n = {p.n: p for p in pages}
    out, notes = [], []
    for i, s in enumerate(sentences(draft.answer), 1):
        marks = [int(m) for m in CITE.findall(s)]
        terms = key_terms(s)
        cited_ok = (
            bool(marks)
            and all(m in by_n for m in marks)
            and (
                not terms
                or _fully_supported_by(
                    terms,
                    Page(
                        0,
                        "",
                        " ".join(by_n[m].title for m in marks),
                        " ".join(by_n[m].text for m in marks),
                    ),
                )
            )
        )
        if cited_ok or not terms or HEDGE.search(s):
            out.append(s)
            continue
        target = next((p.n for p in pages if _fully_supported_by(terms, p)), None)
        if target is None:
            out.append(s)
            continue
        bare = CITE.sub("", s).rstrip()
        stop = bare[-1] if bare and bare[-1] in ".!?" else ""
        out.append(f"{bare.rstrip('.!?').rstrip()} [{target}]{stop or '.'}")
        notes.append(
            f"sentence {i}: citation {marks or 'none'} -> [{target}] (all of {terms[:6]} found in source {target})"
        )
    if not notes:
        return draft, []
    cites = sorted({int(m) for m in CITE.findall(" ".join(out))})
    return Draft(answer=" ".join(out), citations=cites), notes


def is_hedge(answer: str) -> bool:
    return HEDGE.search(answer) is not None and not CITE.search(answer)
