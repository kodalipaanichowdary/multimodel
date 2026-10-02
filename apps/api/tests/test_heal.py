import json

import pytest
from pos_schemas import ModelProfile, Verdict

from app.agent_runtime.heal import generate_typed
from app.models.base import LLMResult, Message, Metrics

PROFILE = ModelProfile(model="fake")
M = Metrics(model="fake", ttft_ms=1, tok_s=1.0, total_ms=2, prompt_tokens=3, completion_tokens=4)


class FakeClient:
    """Returns scripted replies in order; records every conversation it saw."""

    name = "fake"

    def __init__(self, *replies: str) -> None:
        self.replies = list(replies)
        self.seen: list[list[Message]] = []

    async def generate(self, profile, messages, schema):
        self.seen.append(list(messages))
        return LLMResult(self.replies.pop(0), M)


FALLBACK = Verdict(passed=False, issues=["fallback"])


@pytest.mark.asyncio
async def test_pass_first_try():
    c = FakeClient(json.dumps({"passed": True}))
    r = await generate_typed(c, PROFILE, [Message("user", "x")], Verdict, lambda: FALLBACK)
    assert r.value == Verdict(passed=True)
    assert (r.attempts, r.healed, r.fell_back, len(c.seen)) == (1, False, False, 1)


@pytest.mark.asyncio
async def test_heal_appends_exact_validation_error_and_retries_once():
    c = FakeClient('{"passed": "yes"}', '{"passed": true, "issues": []}')
    seen_attempts = []

    async def on_attempt(n, m):
        seen_attempts.append(n)

    r = await generate_typed(
        c, PROFILE, [Message("user", "x")], Verdict, lambda: FALLBACK, on_attempt=on_attempt
    )
    assert r.value.passed is True and r.healed and r.attempts == 2 and not r.fell_back
    assert seen_attempts == [1, 2]
    retry = c.seen[1]
    assert retry[-2] == Message("assistant", '{"passed": "yes"}')  # the bad reply is shown back
    feedback = retry[-1].content
    # the exact pydantic error, not a paraphrase
    assert r.errors[0][0]["type"] == "bool_type"
    assert json.dumps(r.errors[0], default=str) in feedback
    assert "Input should be a valid boolean" in feedback


@pytest.mark.asyncio
async def test_fallback_after_second_failure():
    c = FakeClient("not json at all", '{"issues": []}')
    r = await generate_typed(c, PROFILE, [Message("user", "x")], Verdict, lambda: FALLBACK)
    assert r.value is FALLBACK and r.fell_back and r.attempts == 2 and len(c.seen) == 2
    assert r.errors[0][0]["type"] == "json_invalid" and r.errors[1][0]["type"] == "missing"


@pytest.mark.asyncio
async def test_context_validators_participate_in_healing():
    from pos_schemas import ResearchResult

    bad = {"summary": "s", "sources": [{"url": "https://made.up/x"}], "confidence": 0.5}
    good = {"summary": "s", "sources": [{"url": "https://real.org/a"}], "confidence": 0.5}
    c = FakeClient(json.dumps(bad), json.dumps(good))
    r = await generate_typed(
        c,
        PROFILE,
        [Message("user", "x")],
        ResearchResult,
        lambda: ResearchResult(summary="", sources=[], confidence=0),
        context={"fetched_urls": {"https://real.org/a"}},
    )
    assert r.healed and r.value.sources[0].url == "https://real.org/a"
    assert "not fetched" in c.seen[1][-1].content
