"""Opt-in live test (RUN_LIVE=1): golden question against real Ollama + real web search.

Never hardcodes the answer. It asserts the answer is GROUNDED: it cites a URL that was
fetched during this run, and the validator accepted every sentence against those pages.
"""

import os
import re
from dataclasses import replace

import pytest
from app.config import Settings
from app.main import create_app
from fastapi.testclient import TestClient
from pos_schemas import parse_event

pytestmark = pytest.mark.skipif(
    os.getenv("RUN_LIVE") != "1", reason="set RUN_LIVE=1 (needs Ollama + internet)"
)

GOLDEN = "who is cm of telangana"


def test_golden_question_is_answered_from_fetched_sources():
    s = replace(Settings(), db_path=":memory:", mock_executor=False, llm_provider="ollama")
    with TestClient(create_app(s)) as c, c.websocket_connect("/ws") as ws:
        tid = c.post("/tasks", json={"prompt": GOLDEN}).json()["task_id"]
        ev = []
        while True:
            e = parse_event(ws.receive_text())
            if e.task_id == tid:
                ev.append(e)
                if e.type.startswith("execution."):
                    break
    assert ev[-1].type == "execution.completed", ev[-1]
    fetched = {
        e.payload.args["url"]
        for e in ev
        if e.type == "tool.started" and e.payload.tool_id == "fetch_url"
    }
    ok_calls = {e.payload.call_id for e in ev if e.type == "tool.completed"}
    fetched_ok = {
        e.payload.args["url"]
        for e in ev
        if e.type == "tool.started"
        and e.payload.tool_id == "fetch_url"
        and e.payload.call_id in ok_calls
    }
    assert fetched_ok, f"nothing fetched: {fetched}"
    validator = [
        e.payload.summary
        for e in ev
        if e.type == "agent.completed" and e.payload.agent_id == "validator"
    ]
    assert validator[-1].startswith("grounded"), validator
    answer = next(e.payload.content for e in ev if e.type == "artifact.created")
    assert not answer.startswith("**Could not verify**"), answer
    cited = set(re.findall(r"\((https?://[^)\s]+)\)", answer))
    assert cited and cited <= fetched_ok, (cited, fetched_ok)
    print("\nLIVE ANSWER:\n" + answer)
