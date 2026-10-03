"""Grounding guard (Validator). Pure functions, no model.

A fetched page is a Page(n, url, title, text). The Writer's Draft cites pages with [n] / [1, 2]
markers. For every sentence:
  - it must carry at least one valid marker (hedges like "could not verify" are exempt);
  - its key terms (names, numbers, dates) must CO-OCCUR in the cited page: within a window of
    WINDOW consecutive segments (lines / sentences) of the passage the model was shown. Terms that
    are in the page title (its subject) count as context. Every number must be in that window.
Scattered matches do not count: "since 2018" is not supported by a page that says "since 2023"
next to the name and mentions 2018 elsewhere.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from pos_schemas import Draft, Verdict

# [1], [1, 2, 3], [1][2]  (MARKER finds groups; numbers() expands them)
MARKER = re.compile(r"\[(\d+(?:\s*,\s*\d+)*)\]")
_SENT = re.compile(r"(?<=[.!?])\s+(?=\S)|(?<=\])\s+(?=[A-Z])")
_SEG = re.compile(r"\s+\|\s+|\n+|(?<=[.!?])\s+(?=[A-Z0-9])")
_WORD = re.compile(r"[A-Za-z\u00c0-\u024f][\w\u00c0-\u024f'\u2019.-]*|\d[\d,.:/-]*")
HEDGE = re.compile(
    r"\b(could not|cannot|can't|unable to) (be )?(verify|verified|confirm|find)\b", re.I
)
MIN_SUPPORT = 0.75
WINDOW = 3

# capitalised words that carry no claim on their own
_STOP = set(
    "the a an this that these those it its he she they his her their there as in on at of for from "
    "by with and or but according currently current today since also however yes no i we you is "
    "was are were be been has have had who what which when where source sources answer based per my your our "
    "mr mrs ms dr sri shri".split()
)


@dataclass(frozen=True)
class Page:
    n: int
    url: str
    title: str
    text: str


def numbers(text: str) -> list[int]:
    """All cited source numbers in order of appearance: '[1, 2] x [3]' -> [1, 2, 3]."""
    return [int(n) for g in MARKER.findall(text) for n in re.split(r"\s*,\s*", g)]


_ONLY_MARKS = re.compile(r"^(\s*" + MARKER.pattern + r"[\s.,;]*)+$")


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


def dedupe(answer: str) -> str:
    """Greedy decoding can loop; repeated sentences add nothing."""
    seen: set[str] = set()
    out = []
    for s in sentences(answer):
        key = re.sub(r"\W+", " ", MARKER.sub("", s)).strip().lower()
        if key and key not in seen:
            seen.add(key)
            out.append(s)
    return " ".join(out)


def key_terms(sentence: str) -> list[str]:
    """Proper-noun-like words and numbers: the parts of a sentence that make it a specific claim."""
    plain = MARKER.sub(" ", sentence)
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
        return re.search(rf"(?<!\d){re.escape(term)}(?!\d)", haystack) is not None
    return re.search(rf"(?<![\w]){re.escape(term.lower())}(?![\w])", haystack) is not None


def _segments(text: str) -> list[str]:
    return [s.lower() for s in _SEG.split(text) if s.strip()]


def support(terms: list[str], pages: list[Page]) -> tuple[bool, list[str]]:
    """Do the terms co-occur in one window of one of `pages`? Returns (ok, best missing list)."""
    best_missing = terms
    for p in pages:
        title = p.title.lower()
        need = [t for t in terms if t[0].isdigit() or not _found(t, title)]
        if not need:
            return True, []
        segs = _segments(p.text) or [""]
        for i in range(len(segs)):
            window = " ".join(segs[i : i + WINDOW])
            missing = [t for t in need if not _found(t, window)]
            numbers_ok = not any(t[0].isdigit() for t in missing)
            ratio = 1 - len(missing) / len(terms)
            if numbers_ok and ratio >= MIN_SUPPORT:
                return True, []
            if len(missing) < len(best_missing):
                best_missing = missing
    return False, best_missing


def check(draft: Draft, pages: list[Page]) -> Verdict:
    by_n = {p.n: p for p in pages}
    issues: list[str] = []
    grounded = 0
    for i, s in enumerate(sentences(draft.answer), 1):
        marks = numbers(s)
        if not marks:
            if HEDGE.search(s):
                continue
            issues.append(f"sentence {i} has no [n] citation: {s[:120]!r}")
            continue
        bad = sorted({m for m in marks if m not in by_n})
        if bad:
            issues.append(f"sentence {i} cites unknown source(s) {bad}")
            continue
        terms = key_terms(s)
        if terms:
            ok, missing = support(terms, [by_n[m] for m in dict.fromkeys(marks)])
            if not ok:
                issues.append(
                    f"sentence {i} not supported by cited source(s) {sorted(set(marks))}: "
                    f"not stated together there: {missing[:6]}"
                )
                continue
        grounded += 1
    if not issues and grounded == 0 and not HEDGE.search(draft.answer):
        issues.append("no sentence is grounded in a cited source")
    return Verdict(passed=not issues, issues=issues)


def align(draft: Draft, pages: list[Page]) -> tuple[Draft, list[str]]:
    """Re-point a sentence's marker to the fetched source where its key terms co-occur.

    Only for sentences that are uncited or not supported by what they cite. Never invents
    support: a sentence no single fetched page supports is left as is (check() fails it).
    Returns the aligned draft and a note per change.
    """
    by_n = {p.n: p for p in pages}
    out, notes = [], []
    for i, s in enumerate(sentences(draft.answer), 1):
        marks = numbers(s)
        terms = key_terms(s)
        cited = [by_n[m] for m in dict.fromkeys(marks) if m in by_n]
        cited_ok = (
            bool(marks)
            and len(cited) == len(set(marks))
            and (not terms or support(terms, cited)[0])
        )
        if cited_ok or not terms or HEDGE.search(s):
            out.append(s)
            continue
        target = next((p.n for p in pages if support(terms, [p])[0]), None)
        if target is None:
            out.append(s)
            continue
        bare = MARKER.sub("", s).rstrip()
        stop = bare[-1] if bare and bare[-1] in ".!?" else ""
        out.append(f"{bare.rstrip('.!?').rstrip()} [{target}]{stop or '.'}")
        notes.append(
            f"sentence {i}: citation {marks or 'none'} -> [{target}] "
            f"({terms[:6]} stated together in source {target})"
        )
    if not notes:
        return draft, []
    return Draft(answer=" ".join(out), citations=sorted(set(numbers(" ".join(out))))), notes


def is_hedge(answer: str) -> bool:
    return HEDGE.search(answer) is not None and not MARKER.search(answer)


# ---------------------------------------------------------------------------- full validator (P3)

_URL_IN_TEXT = re.compile(r"https?://[^\s)\]>\"']+")
_WORDS = re.compile(r"[A-Za-z0-9]{2,}")
_NAME = re.compile(r"\b[A-Z][a-z]{2,}\b")
_NUM = re.compile(r"\b\d[\d,.]*\b")


def _contradictions(draft: Draft, pages: list[Page], prompt: str) -> list[str]:
    """Another fetched page states the same subject with different details.

    For a cited sentence: subject = its key terms that also occur in the task, value = the rest
    (the answer: names, numbers). A page conflicts when its title shares a subject term, it never
    mentions any value term, and one window holds every subject term plus another name/number.
    """
    task_words = {w.lower() for w in _WORDS.findall(prompt)}
    issues: list[str] = []
    for i, s in enumerate(sentences(draft.answer), 1):
        cited = set(numbers(s))
        terms = key_terms(s)
        subject = [t for t in terms if t.lower() in task_words]
        value = [t for t in terms if t.lower() not in task_words]
        if not cited or len(subject) < 2 or not value:
            continue
        wants_number = any(v[0].isdigit() for v in value)
        wants_name = any(not v[0].isdigit() for v in value)
        for p in pages:
            if p.n in cited or not any(_found(t, p.title.lower()) for t in subject):
                continue
            if any(_found(v, (p.title + " " + p.text).lower()) for v in value):
                continue
            segs = [x for x in _SEG.split(p.text) if x.strip()]
            for j in range(len(segs)):
                window = " ".join(segs[j : j + WINDOW])
                if not all(_found(t, window.lower()) for t in subject):
                    continue
                other_names = [
                    n
                    for n in _NAME.findall(window)
                    if n.lower() not in task_words and n not in subject
                ]
                if (wants_number and _NUM.search(window)) or (wants_name and other_names):
                    issues.append(
                        f"sentence {i}: sources disagree; source [{p.n}] states the same subject without "
                        f"{value[:4]}: {window[:100]!r}"
                    )
                    break
    return issues


def validate_draft(
    draft: Draft, pages: list[Page], prompt: str = ""
) -> tuple[Draft, Verdict, list[str]]:
    """The Validator. Returns (possibly repaired draft, verdict, notes for the event log).

    Repairs (noted, never silent): repeated sentences removed; a marker re-pointed to the page
    where the sentence's terms co-occur. Rejections: truncated output, no substantive claim,
    URLs that were not fetched, unsupported / uncited sentences, sources that disagree.
    """
    notes: list[str] = []
    issues: list[str] = []
    raw = draft.answer.strip()
    if raw.count("[") != raw.count("]") or not re.search(r"([.!?]|\])[\"')]*\s*$", raw):
        issues.append("truncated: the answer does not end in a complete, cited sentence")
    if len(_WORDS.findall(MARKER.sub(" ", raw))) < 3:
        issues.append("no substantive claim in the answer")
    fetched = {p.url.rstrip("/") for p in pages}
    invented = [u for u in _URL_IN_TEXT.findall(raw) if u.rstrip("/.,;") not in fetched]
    if invented:
        issues.append(f"answer contains URLs that were not fetched: {invented[:3]}")
    deduped = dedupe(raw)
    dropped = len(sentences(raw)) - len(sentences(deduped))
    if dropped:
        notes.append(f"Removed {dropped} repeated sentence(s)")
    fixed, align_notes = align(draft.model_copy(update={"answer": deduped}), pages)
    notes += [f"Re-attached citation: {n}" for n in align_notes]
    verdict = check(fixed, pages)
    issues += verdict.issues
    if verdict.passed:
        issues += _contradictions(fixed, pages, prompt)
    return fixed, Verdict(passed=not issues, issues=issues), notes
