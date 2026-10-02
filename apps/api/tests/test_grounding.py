from pos_schemas import Draft

from app.agent_runtime.grounding import Page, check, key_terms, sentences
from app.agent_runtime.passages import select

PAGES = [
    Page(
        1,
        "https://ex.org/a",
        "Zephyr Harbor Authority",
        "The Zephyr Harbor Authority is chaired by Ada Quill since 2024.",
    ),
    Page(2, "https://ex.org/b", "News", "Ada Quill opened the north pier in March."),
]


def d(answer: str, cites=("https://ex.org/a",)) -> Draft:
    return Draft(answer=answer, citations=list(cites))


def test_supported_sentence_passes():
    v = check(d("The Zephyr Harbor Authority is chaired by Ada Quill [1]."), PAGES)
    assert v.passed, v.issues


def test_multi_sentence_each_cited():
    v = check(
        d(
            "Ada Quill chairs the Zephyr Harbor Authority [1]. She opened the north pier in March [2]."
        ),
        PAGES,
    )
    assert v.passed, v.issues


def test_model_memory_name_is_rejected():
    # a plausible-looking answer whose name is NOT in the cited page
    v = check(d("The Zephyr Harbor Authority is chaired by Bob Marsh [1]."), PAGES)
    assert not v.passed and "Bob" in v.issues[0] and "Marsh" in v.issues[0]


def test_wrong_number_is_rejected():
    v = check(d("Ada Quill has chaired the authority since 2019 [1]."), PAGES)
    assert not v.passed and "2019" in v.issues[0]


def test_uncited_sentence_is_rejected():
    v = check(d("Ada Quill chairs the Zephyr Harbor Authority."), PAGES)
    assert not v.passed and "no [n] citation" in v.issues[0]


def test_unknown_marker_is_rejected():
    v = check(d("Ada Quill chairs it [7]."), PAGES)
    assert not v.passed and "unknown source" in v.issues[0]


def test_hedge_without_citation_is_allowed():
    assert check(d("I could not verify who chairs it.", cites=()), PAGES).passed


def test_sentence_split_and_terms():
    assert sentences("A is B [1]. C is D [2].") == ["A is B [1].", "C is D [2]."]
    assert sentences("A is B since 2024. [1] C is D. [2][1]") == [
        "A is B since 2024. [1]",
        "C is D. [2][1]",
    ]
    assert key_terms("The CM of Telangana is A. Revanth Reddy since 7 December 2023 [1].") == [
        "CM",
        "Telangana",
        "Revanth",
        "Reddy",
        "7",
        "December",
        "2023",  # initials like "A." carry no claim
    ]


def test_passage_selection_prefers_query_lines():
    text = "Menu\nCookie banner\nThe Chief Minister of Telangana is X.\nWeather today\nTelangana was formed in 2014."
    out = select(text, "who is cm of telangana chief minister", budget=200)
    assert "Chief Minister of Telangana is X" in out
    assert "Cookie" not in out


def test_marker_after_full_stop_counts():
    assert check(
        d("The Zephyr Harbor Authority is chaired by Ada Quill since 2024. [1]"), PAGES
    ).passed
