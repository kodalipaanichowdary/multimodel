"""G3.7 seeded bad outputs. "Caught" = rejected, or repaired with a visible note.

Good controls must pass untouched, so the table cannot be gamed by flagging everything.
"""

import pytest
from app.agent_runtime.grounding import Page, validate_draft
from pos_schemas import Draft

PROMPT = "Who chairs the Zephyr Harbor Authority?"
P1 = Page(
    1,
    "https://example.org/zephyr-harbor",
    "Zephyr Harbor Authority",
    "The Zephyr Harbor Authority is chaired by Ada Quill since 2024. The harbor handles 1200 vessels a year. "
    "It was founded in 1931 by the town of Zephyr.",
)
P2 = Page(
    2,
    "https://example.net/zephyr-news",
    "Zephyr local news",
    "Ada Quill opened the new north pier in March. The Zephyr Harbor Authority reported record traffic.",
)
P3_CONFLICT = Page(
    3,
    "https://example.com/zephyr-annual-report",
    "Zephyr Harbor Authority annual report",
    "The Zephyr Harbor Authority is chaired by Bob Marsh since 2021. Bob Marsh presented the budget.",
)
BASE = [P1, P2]
GOOD = "The Zephyr Harbor Authority is chaired by Ada Quill since 2024 [1]."


def d(answer, cites=(1,)):
    return Draft(answer=answer, citations=list(cites))


FAULTS = [
    ("wrong date", d("The Zephyr Harbor Authority is chaired by Ada Quill since 2019 [1]."), BASE),
    (
        "missing citation",
        d("The Zephyr Harbor Authority is chaired by Ada Quill since 2024.", ()),
        BASE,
    ),
    ("wrong number", d("The harbor handles 1500 vessels a year [1]."), BASE),
    ("citation to wrong source", d("Ada Quill opened the new north pier in March [1]."), BASE),
    ("empty-but-valid", d("[1]."), BASE),
    ("invented URL", d(GOOD[:-1] + " (see https://zephyr-facts.example/chair)."), BASE),
    ("contradictory sources", d(GOOD), [*BASE, P3_CONFLICT]),
    ("truncated", d("The Zephyr Harbor Authority is chaired by Ada Qu"), BASE),
    ("duplicated sentence", d(f"{GOOD} {GOOD}"), BASE),
    ("wrong entity", d("The Zephyr Harbor Authority is chaired by Mira Holt [1]."), BASE),
]
CONTROLS = [
    ("exact claim", d(GOOD), BASE),
    (
        "two cited sentences",
        d(GOOD + " Ada Quill opened the new north pier in March [2].", (1, 2)),
        BASE,
    ),
    ("honest hedge", d("I could not verify who chairs the authority.", ()), BASE),
]


def outcome(draft, pages):
    _fixed, verdict, notes = validate_draft(draft, pages, PROMPT)
    if not verdict.passed:
        return "rejected", verdict.issues
    if notes:
        return "repaired", notes
    return "passed", []


def test_seeded_fault_table():
    rows = [(name, *outcome(dr, pages)) for name, dr, pages in FAULTS]
    print("\n| seeded fault | validator | evidence |\n|---|---|---|")
    for name, how, why in rows:
        print(f"| {name} | {how} | {(why[0] if why else '')[:110]} |")
    caught = sum(how != "passed" for _, how, _ in rows)
    print(f"caught {caught}/10")
    assert caught >= 9


@pytest.mark.parametrize("name,draft,pages", CONTROLS, ids=[c[0] for c in CONTROLS])
def test_good_controls_pass_untouched(name, draft, pages):
    fixed, verdict, notes = validate_draft(draft, pages, PROMPT)
    assert verdict.passed, verdict.issues
    assert notes == [] and fixed.answer == draft.answer


def test_repairs_are_correct_not_just_flagged():
    fixed, verdict, notes = validate_draft(FAULTS[3][1], BASE, PROMPT)  # wrong source
    assert verdict.passed and fixed.answer.endswith("[2].") and "-> [2]" in notes[0]
    fixed, verdict, notes = validate_draft(FAULTS[8][1], BASE, PROMPT)  # duplicate
    assert verdict.passed and fixed.answer == GOOD and notes == ["Removed 1 repeated sentence(s)"]
