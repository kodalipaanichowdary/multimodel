"""Planner quality guard: looping / runaway research queries are clamped before any tool call."""

from app.agent_runtime.pipeline import PLANNER_SYSTEM, QUERY_MAX_WORDS, clamp_query, normalize_plan
from pos_schemas import Plan, PlanStep

# verbatim shape of a llama3.2:3b output from benchmarks/p3_matrix run 2 (prompt p06)
LOOP = (
    "Mount Kenya height in meters and feet and inches and kilometers and miles and yards and "
    "centimeters and millimeters and feet and inches and yards and inches and feet and inches"
)


def test_looping_query_is_clamped_in_normalize_plan():
    plan = Plan(
        search_query="heights of Mount Kenya, Kilimanjaro",
        steps=[
            PlanStep(
                agent_id="research", goal="Find the height of Mount Kenya", id="r1", query=LOOP
            ),
            PlanStep(
                agent_id="research",
                goal="Find the height of Kilimanjaro",
                id="r2",
                query="Kilimanjaro height",
            ),
            PlanStep(agent_id="writer", goal="w", id="w", depends_on=["r1", "r2"]),
            PlanStep(agent_id="validator", goal="v", id="v", depends_on=["w"]),
        ],
    )
    q = normalize_plan(plan, "Compare the heights of Mount Kenya and Kilimanjaro")[0].query
    words = q.lower().split()
    assert len(words) <= QUERY_MAX_WORDS
    assert len(words) == len(set(words)), q  # no repeated words left
    assert q.startswith("Mount Kenya height in meters")


def test_clamp_keeps_normal_queries_unchanged():
    for q in (
        "Kilimanjaro height",
        "population of Lyon 2024",
        "Who chairs the Zephyr Harbor Authority?",
    ):
        assert clamp_query(q) == q


def test_clamp_caps_words_and_chars():
    assert len(clamp_query(" ".join(f"w{i}" for i in range(50))).split()) == QUERY_MAX_WORDS
    assert len(clamp_query("x" * 500)) == 200


def test_planner_prompt_asks_for_short_queries():
    assert "Each query max 8 words, no repeated phrases." in PLANNER_SYSTEM
