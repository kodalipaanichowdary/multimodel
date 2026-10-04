"""Q.2 / Q.5 question shape: single facts get one branch; compares get one per listed item."""

import pytest
from app.agent_runtime.taskshape import item_query, shape


@pytest.mark.parametrize(
    "prompt",
    [
        "who is cm of telangana",
        "How tall is Mount Everest?",
        "Who wrote the novel Pride and Prejudice?",
        "When did the Hubble Space Telescope launch?",
        "What is the population of Iceland?",
    ],
)
def test_single_fact(prompt):
    assert shape(prompt).kind == "single"


@pytest.mark.parametrize(
    "prompt,attr,items",
    [
        ("Compare the heights of Mount Everest and K2", "heights", ("Mount Everest", "K2")),
        (
            "Compare the populations of Lyon, Marseille and Nice",
            "populations",
            ("Lyon", "Marseille", "Nice"),
        ),
        (
            "Compare the boiling points of water and ethanol in Celsius",
            "boiling points",
            ("water", "ethanol"),
        ),
        ("Compare Python and Rust for writing command-line tools", "", ("Python", "Rust")),
        (
            "Compare Zephyr Harbor, Quillon Library and Marsh Observatory",
            "",
            ("Zephyr Harbor", "Quillon Library", "Marsh Observatory"),
        ),
    ],
)
def test_compare_items(prompt, attr, items):
    s = shape(prompt)
    assert (s.kind, s.attr, s.items) == ("multi", attr, items)


def test_multi_without_parsable_list_keeps_planner_branches():
    s = shape("Which is older, the University of Bologna or the University of Oxford?")
    assert s.kind == "multi"


def test_at_most_four_items():
    s = shape("Compare A1, B2, C3, D4 and E5")
    assert len(s.items) == 4


def test_item_query():
    assert item_query("heights", "Mount Everest") == "Mount Everest height"
    assert item_query("", "Python") == "Python"
