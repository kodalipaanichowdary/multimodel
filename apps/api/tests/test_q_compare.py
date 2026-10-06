"""Q.5 compare: one verified finding per item, merged; unverified items named; wrong claims never.

Real runtime (LangGraph pipeline + MCP stub tools) with the stub model, optionally wrapped so a
chosen item's draft is corrupted.
"""

import json
import re

import pytest
from app.agent_runtime.pipeline import item_branches
from app.agent_runtime.taskshape import shape
from app.main import create_app
from app.models.base import LLMResult
from fastapi.testclient import TestClient
from pos_schemas import parse_event

COMPARE = "Compare Zephyr Harbor, Quillon Library and Marsh Observatory"


def run(client, prompt):
    with client.websocket_connect("/ws") as ws:
        tid = client.post("/tasks", json={"prompt": prompt}).json()["task_id"]
        out = []
        while True:
            e = parse_event(ws.receive_text())
            if e.task_id != tid:
                continue
            out.append(e)
            if e.type.startswith("execution."):
                return out


def answer(ev):
    return next(e.payload.content for e in ev if e.type == "artifact.created")


def status(ev):
    done = [
        e.payload.summary
        for e in ev
        if e.type == "agent.completed" and e.payload.agent_id == "orchestrator"
    ]
    return re.search(r"done \((\w+)\)", done[-1]).group(1)


class Corrupt:
    """Wraps the stub model; rewrites the Writer's draft for items matching `when`."""

    def __init__(self, inner, when, how):
        self.inner, self.when, self.how, self.name = inner, when, how, "corrupt"

    async def generate(self, profile, messages, schema):
        res = await self.inner.generate(profile, messages, schema)
        task_msg = messages[1].content  # the TASK + SOURCES message (also on a revision)
        if schema.get("title") == "Draft" and re.search(self.when, task_msg.split("\n", 1)[0]):
            out = json.loads(res.text)
            first = int(re.search(r"^\[(\d+)\] ", task_msg, re.M).group(1))
            return LLMResult(json.dumps(self.how(out, first)), res.metrics)
        return res


def with_llm(settings, wrap):
    c = TestClient(create_app(settings))
    c.__enter__()
    c.app.state.executor._deps.llm = wrap(c.app.state.executor._deps.llm)
    return c


def test_item_branches_one_per_item():
    b = item_branches(shape("Compare the heights of Mount Everest and K2"))
    assert [(x.instance, x.query, x.goal, x.level) for x in b] == [
        ("research#1", "Mount Everest height", "Mount Everest", 0),
        ("research#2", "K2 height", "K2", 0),
    ]


def test_every_item_verified_and_merged(real_client):
    ev = run(real_client, COMPARE)
    text = answer(ev)
    assert status(ev) == "grounded"
    for fact in ("Ada Quill", "Quillon Library", "Marsh Observatory"):
        assert fact in text
    assert "Could not verify" not in text
    writer_calls = [e for e in ev if e.type == "model.metrics" and e.payload.agent_id == "writer"]
    assert len(writer_calls) == 3  # one draft per item, no revisions needed
    plan = next(e for e in ev if e.type == "task.planned").payload.steps
    assert [s.agent_id for s in plan] == [
        "research#1",
        "research#2",
        "research#3",
        "writer",
        "validator",
    ]


def _wrong_number(out, first):
    out["answer"] = re.sub(r"\b48000\b", "99000", out["answer"])
    return out


def test_wrong_item_is_named_as_unverified_never_stated(real_settings):
    c = with_llm(real_settings, lambda llm: Corrupt(llm, r"Quillon", _wrong_number))
    try:
        ev = run(c, COMPARE)
    finally:
        c.__exit__(None, None, None)
    text = answer(ev)
    assert "99000" not in text and "48000" not in text
    assert "Could not verify: Quillon Library." in text
    assert "Ada Quill" in text and "Marsh Observatory" in text
    assert status(ev) == "grounded"  # partial answer: verified items + named gap


def _off_topic(out, first):
    return {"answer": f"It was built in 1967 [{first}].", "citations": [first]}


def test_sentence_that_does_not_name_its_item_is_not_accepted(real_settings):
    c = with_llm(real_settings, lambda llm: Corrupt(llm, r"Marsh", _off_topic))
    try:
        ev = run(c, COMPARE)
    finally:
        c.__exit__(None, None, None)
    text = answer(ev)
    assert "1967" not in text and "Could not verify: Marsh Observatory." in text


def test_no_item_verified_is_an_honest_hedge(real_settings):
    c = with_llm(real_settings, lambda llm: Corrupt(llm, r".", _off_topic))
    try:
        ev = run(c, COMPARE)
    finally:
        c.__exit__(None, None, None)
    text = answer(ev)
    assert text.startswith("I could not verify") and "[" not in text
    assert status(ev) == "hedged"


@pytest.mark.parametrize("prompt", ["Who chairs the Zephyr Harbor Authority?"])
def test_single_fact_path_unchanged(real_client, prompt):
    ev = run(real_client, prompt)
    writer_calls = [e for e in ev if e.type == "model.metrics" and e.payload.agent_id == "writer"]
    assert len(writer_calls) == 1 and "Ada Quill" in answer(ev)
