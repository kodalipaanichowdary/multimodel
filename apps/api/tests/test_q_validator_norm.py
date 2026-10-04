"""Q.3 validator normalization: format differences pass, wrong values still fail (near misses)."""

import pytest
from app.agent_runtime.grounding import Page, key_terms, validate_draft
from pos_schemas import Draft

EVEREST = Page(
    1,
    "https://en.wikipedia.org/wiki/Mount_Everest",
    "Mount Everest - Wikipedia",
    "Mount Everest is Earth's highest mountain above sea level. Its elevation of 8,848.86 m was "
    "most recently established in 2020 by the Chinese and Nepali authorities.",
)
WATER = Page(
    1,
    "https://en.wikipedia.org/wiki/Boiling_point",
    "Boiling point - Wikipedia",
    "At sea level, water boils at 100 \u00b0C (212 \u00b0F).",
)
CITY = Page(
    1,
    "https://example.org/bangalore",
    "Bangalore - population",
    "Bangalore has a population of 8,443,675 according to the 2011 census.",
)
HARBOR = Page(
    1,
    "https://example.org/harbor",
    "Zephyr Harbor Authority",
    "The harbor handles 1200 vessels a year.",
)


def ok(answer, page, prompt="q"):
    _, v, _ = validate_draft(Draft(answer=answer, citations=[1]), [page], prompt)
    return v.passed, v.issues


PASSES = [
    ("separator added", "The harbor handles 1,200 vessels a year [1].", HARBOR),
    ("same decimal", "Its elevation is 8,848.86 m [1].", EVEREST),
    ("degrees Celsius vs \u00b0C", "Water boils at 100 degrees Celsius at sea level [1].", WATER),
    ("degC", "Water boils at 100 degC at sea level [1].", WATER),
    ("discourse word", "Therefore, Bangalore had a population of 8,443,675 in 2011 [1].", CITY),
]
NEAR_MISSES = [
    ("rounded", "Its elevation is 8,849 m [1].", EVEREST),
    ("truncated decimal", "Its elevation is 8,848 m [1].", EVEREST),
    ("digit run of a bigger number", "The harbor handles 200 vessels a year [1].", HARBOR),
    ("wrong value with separator", "The harbor handles 1,500 vessels a year [1].", HARBOR),
    ("Fahrenheit value as Celsius", "Water boils at 212 degrees Celsius at sea level [1].", WATER),
    ("wrong year", "Bangalore had a population of 8,443,675 in 2021 [1].", CITY),
    ("wrong population", "Bangalore had a population of 8,443,000 in 2011 [1].", CITY),
]


@pytest.mark.parametrize("name,answer,page", PASSES, ids=[p[0] for p in PASSES])
def test_format_differences_pass(name, answer, page):
    passed, issues = ok(answer, page)
    assert passed, (name, issues)


@pytest.mark.parametrize("name,answer,page", NEAR_MISSES, ids=[n[0] for n in NEAR_MISSES])
def test_near_misses_still_fail(name, answer, page):
    passed, issues = ok(answer, page)
    assert not passed, (name, issues)


def test_possessive_is_still_a_distinct_term():
    """b2 (possessive stripping) was measured live and reverted: it let a weak-source figure
    through (after-b c02, wrong 0 -> 1). Until a source-quality guard exists, keep it strict."""
    assert "Bangalore's" in key_terms("Bangalore's population [1].")


def test_discourse_words_are_not_claims_but_names_are():
    terms = key_terms("Therefore, Thus and Overall Ada Quill won [1].")
    assert terms == ["Ada", "Quill"]
