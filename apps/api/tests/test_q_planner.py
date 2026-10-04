"""Q.2 planner: missing ids repaired in code (no fallback); single facts collapse to one branch."""

import asyncio
import json

from app.agent_runtime.heal import generate_typed
from app.agent_runtime.pipeline import PIPELINE, fit_branches, normalize_plan, repair_plan
from app.models.base import LLMResult, Message, Metrics
from pos_schemas import ModelProfile, Plan

# the p04 failure shape: research steps without ids, writer depends on ids nobody declared
NO_IDS = {
    "search_query": "python vs rust cli tools",
    "steps": [
        {"agent_id": "research", "goal": "Python CLI", "query": "Python command-line tools"},
        {"agent_id": "research", "goal": "Rust CLI", "query": "Rust command-line tools"},
        {"agent_id": "writer", "goal": "compare", "depends_on": ["r1", "r2"]},
        {"agent_id": "validator", "goal": "check", "depends_on": ["w"]},
    ],
}


def test_repair_assigns_ids_and_keeps_known_deps():
    fixed = repair_plan(json.loads(json.dumps(NO_IDS)))
    assert [s["id"] for s in fixed["steps"]] == ["r1", "r2", "w", "v"]
    assert fixed["steps"][2]["depends_on"] == ["r1", "r2"]
    Plan.model_validate(fixed, context={"allowed_agents": set(PIPELINE)})


def test_repair_renames_duplicates_and_drops_unknown_deps():
    fixed = repair_plan(
        {
            "search_query": "q q",
            "steps": [
                {"id": "r1", "agent_id": "research", "goal": "a"},
                {"id": "r1", "agent_id": "research", "goal": "b", "depends_on": ["zz"]},
                {"agent_id": "writer", "goal": "w", "depends_on": ["r1", "later"]},
            ],
        }
    )
    assert [s["id"] for s in fixed["steps"]] == ["r1", "r2", "w"]
    assert fixed["steps"][1]["depends_on"] == [] and fixed["steps"][2]["depends_on"] == ["r1"]


def test_repair_leaves_schema_errors_to_the_schema():
    bad = repair_plan({"search_query": "q q", "steps": [{"agent_id": "hacker", "goal": "x"}]})
    try:
        Plan.model_validate(bad, context={"allowed_agents": set(PIPELINE)})
    except ValueError:
        return
    raise AssertionError("unknown agent must still be rejected")


class _Once:
    name = "once"

    def __init__(self, text):
        self.text, self.calls = text, 0

    async def generate(self, profile, messages, schema):
        self.calls += 1
        return LLMResult(self.text, Metrics("x", 1, 1.0, 1, 1, 1))


def test_generate_typed_applies_repair_first_try():
    llm = _Once(json.dumps(NO_IDS))
    h = asyncio.run(
        generate_typed(
            llm,
            ModelProfile(model="x"),
            [Message("user", "t")],
            Plan,
            lambda: None,
            context={"allowed_agents": set(PIPELINE)},
            repair=repair_plan,
        )
    )
    assert not h.fell_back and h.attempts == 1 and llm.calls == 1


def _three_branch_plan():
    return Plan.model_validate(
        {
            "search_query": "Telangana Chief Minister",
            "steps": [
                {"id": "r1", "agent_id": "research", "goal": "g", "query": "Telangana CM current"},
                {"id": "r2", "agent_id": "research", "goal": "g", "query": "Telangana CM name"},
                {"id": "r3", "agent_id": "research", "goal": "g", "query": "Telangana CM term"},
            ],
        }
    )


def test_single_fact_collapses_to_one_branch():
    plan = _three_branch_plan()
    out = fit_branches(
        normalize_plan(plan, "who is cm of telangana"), plan, "who is cm of telangana"
    )
    assert [(b.instance, b.query, b.level) for b in out] == [
        ("research", "Telangana Chief Minister", 0)
    ]


def test_compare_keeps_its_branches():
    plan = _three_branch_plan()
    p = "Compare the populations of Lyon, Marseille and Nice"
    assert len(fit_branches(normalize_plan(plan, p), plan, p)) == 3
