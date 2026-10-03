from app.agent_runtime.grounding import Page, check, key_terms, sentences
from app.agent_runtime.passages import select
from pos_schemas import Draft

PAGES = [
    Page(
        1,
        "https://ex.org/a",
        "Zephyr Harbor Authority",
        "The Zephyr Harbor Authority is chaired by Ada Quill since 2024.",
    ),
    Page(2, "https://ex.org/b", "News", "Ada Quill opened the north pier in March."),
]


def d(answer: str, cites=(1,)) -> Draft:
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


def test_align_repoints_marker_only_when_one_source_has_every_term():
    from app.agent_runtime.grounding import align

    # right fact, wrong / missing citation -> re-pointed to the page that states it
    fixed, notes = align(d("Ada Quill opened the north pier in March [1]."), PAGES)
    assert fixed.answer == "Ada Quill opened the north pier in March [2]." and fixed.citations == [
        2
    ]
    assert check(fixed, PAGES).passed and "-> [2]" in notes[0]
    fixed, _ = align(d("The Zephyr Harbor Authority is chaired by Ada Quill", cites=()), PAGES)
    assert fixed.answer.endswith("Ada Quill [1].") and check(fixed, PAGES).passed
    # a claim no fetched page fully supports is NOT rescued
    same, notes = align(d("The Zephyr Harbor Authority is chaired by Bob Marsh [1]."), PAGES)
    assert notes == [] and not check(same, PAGES).passed
    # correct citations are left alone
    ok = d("The Zephyr Harbor Authority is chaired by Ada Quill [1].")
    assert align(ok, PAGES) == (ok, [])


def test_svg_titles_do_not_pollute_page_title():
    from app.tools.registry import load_server

    from .conftest import REPO

    fetch = load_server(REPO / "mcp", "fetch_url")
    title, _text = fetch.html_to_text(
        "<head><title>Real Title</title></head><body><svg><title>Icon</title></svg><p>x</p></body>"
    )
    assert title == "Real Title"


def test_multi_citation_markers_are_parsed():
    from app.agent_runtime.grounding import numbers

    assert numbers("A [1, 2, 3]. B [2][3].") == [1, 2, 3, 2, 3]
    assert check(d("Ada Quill chairs the Zephyr Harbor Authority [1, 2]."), PAGES).passed


LIVE_LIKE = [
    Page(
        1,
        "https://w.org/cm",
        "Chief Minister of Telangana - Wikipedia",
        "The Chief Minister of Telangana is the head of government. | Incumbent | Anumula Revanth Reddy "
        "| since 7 December 2023 | Former chief minister K. Chandrashekar Rao served a second term from 13 "
        "December 2018.",
    )
]


def test_terms_must_co_occur_not_just_appear_somewhere():
    ok = Draft(
        answer="The Chief Minister of Telangana is Revanth Reddy since 7 December 2023 [1].",
        citations=[1],
    )
    assert check(ok, LIVE_LIKE).passed, check(ok, LIVE_LIKE).issues
    # every token of this hallucination is on the page, but not stated together
    bad = Draft(
        answer="Revanth Reddy has been Chief Minister since 7 December 2018 [1].", citations=[1]
    )
    v = check(bad, LIVE_LIKE)
    assert not v.passed and "2018" in v.issues[0]
    # and alignment cannot rescue it either
    from app.agent_runtime.grounding import align

    assert align(bad, LIVE_LIKE)[1] == []


def test_dedupe_drops_repeated_sentences():
    from app.agent_runtime.grounding import dedupe

    looped = "X is Y [1]. Z is W [2]. X is Y [1]. X is Y [1]."
    assert dedupe(looped) == "X is Y [1]. Z is W [2]."
