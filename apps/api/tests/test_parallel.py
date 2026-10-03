"""G3.6 parallel research branches (real runtime, stub model, stub tools with simulated latency)."""

import asyncio
from dataclasses import replace
from datetime import datetime

import pytest
from app.agent_runtime.pipeline import normalize_plan
from app.main import create_app
from fastapi.testclient import TestClient
from pos_schemas import Plan, parse_event

COMPARE = "Compare Zephyr Harbor, Quillon Library and Marsh Observatory"
TOOL_DELAY = 0.3  # seconds per search / fetch call
LLM_DELAY = 0.05


def run(client, prompt, on_event=None):
    with client.websocket_connect("/ws") as ws:
        tid = client.post("/tasks", json={"prompt": prompt}).json()["task_id"]
        out = []
        while True:
            e = parse_event(ws.receive_text())
            if e.task_id != tid:
                continue
            out.append(e)
            if on_event:
                on_event(e, client, tid)
            if e.type.startswith("execution."):
                return out


def branch_stats(ev):
    """Research stage wall time, per-branch spans, and peak number of branches running at once."""
    t = lambda e: datetime.fromisoformat(str(e.ts)).timestamp()  # noqa: E731
    starts = {
        e.payload.agent_id: t(e)
        for e in ev
        if e.type == "agent.started" and e.payload.agent_id.startswith("research")
    }
    ends = {
        e.payload.agent_id: t(e)
        for e in ev
        if e.type == "agent.completed" and e.payload.agent_id.startswith("research")
    }
    spans = {a: ends[a] - starts[a] for a in starts}
    wall = max(ends.values()) - min(starts.values())
    marks = sorted([(starts[a], 1) for a in starts] + [(ends[a], -1) for a in ends])
    peak = cur = 0
    for _, d in marks:
        cur += d
        peak = max(peak, cur)
    return wall, spans, peak


class CountingLLM:
    """Wraps the stub model; records how many generate() calls overlap."""

    def __init__(self, inner):
        self.inner, self.name = inner, "counting"
        self.inflight = self.max_inflight = 0

    async def generate(self, profile, messages, schema):
        self.inflight += 1
        self.max_inflight = max(self.max_inflight, self.inflight)
        try:
            return await self.inner.generate(profile, messages, schema)
        finally:
            self.inflight -= 1


@pytest.fixture
def slow_tools(monkeypatch, real_settings):
    monkeypatch.setenv("STUB_TOOL_DELAY_S", str(TOOL_DELAY))
    return replace(real_settings, stub_delay_s=LLM_DELAY)


def _run_mode(settings, parallel: bool):
    with TestClient(create_app(replace(settings, parallel_branches=parallel))) as c:
        llm = CountingLLM(c.app.state.executor._deps.llm)
        c.app.state.executor._deps.llm = llm
        ev = run(c, COMPARE)
    return ev, llm


def test_plan_dag_levels():
    plan = Plan.model_validate(
        {
            "search_query": "x y",
            "steps": [
                {"id": "a", "agent_id": "research", "goal": "g", "query": "qa"},
                {"id": "b", "agent_id": "research", "goal": "g", "query": "qb"},
                {
                    "id": "c",
                    "agent_id": "research",
                    "goal": "g",
                    "query": "qc",
                    "depends_on": ["a"],
                },
                {"id": "w", "agent_id": "writer", "goal": "g", "depends_on": ["a", "b", "c"]},
            ],
        }
    )
    b = normalize_plan(plan, "p")
    assert [(x.instance, x.level, x.depends_on) for x in b] == [
        ("research#1", 0, ()),
        ("research#2", 0, ()),
        ("research#3", 1, ("a",)),
    ]
    single = normalize_plan(
        Plan.model_validate(
            {"search_query": "q q", "steps": [{"agent_id": "research", "goal": "g"}]}
        ),
        "p",
    )
    assert [(x.instance, x.query) for x in single] == [("research", "q q")]  # P2 shape kept


def test_three_branches_run_concurrently_and_beat_sequential(slow_tools):
    par, llm_par = _run_mode(slow_tools, parallel=True)
    seq, llm_seq = _run_mode(slow_tools, parallel=False)
    for ev in (par, seq):
        assert ev[-1].type == "execution.completed"
        plan = next(e for e in ev if e.type == "task.planned").payload.steps
        assert [s.agent_id for s in plan] == [
            "research#1",
            "research#2",
            "research#3",
            "writer",
            "validator",
        ]
        assert plan[3].depends_on == ["r1", "r2", "r3"] and plan[4].depends_on == ["w"]
    wall_p, _spans_p, peak_p = branch_stats(par)
    wall_s, spans_s, peak_s = branch_stats(seq)
    ratio = wall_p / wall_s
    print(
        f"\nresearch stage wall: parallel {wall_p:.2f}s vs sequential {wall_s:.2f}s -> ratio {ratio:.2f}; "
        f"sum of branch spans (sequential) {sum(spans_s.values()):.2f}s; peak concurrent branches {peak_p} vs {peak_s}; "
        f"max model calls in flight {llm_par.max_inflight}"
    )
    assert peak_p >= 3 and peak_s == 1
    assert ratio <= 0.6
    assert llm_par.max_inflight == 1 and llm_seq.max_inflight == 1  # semaphore: one GPU
    # every branch fetched its own topic (search filtered by the branch query)
    fetched = {
        e.payload.agent_id: e.payload.args["url"]
        for e in par
        if e.type == "tool.started" and e.payload.tool_id == "fetch_url"
    }
    assert len(set(fetched.values())) >= 3


def test_kill_during_parallel_stage_closes_every_tool_call(slow_tools):
    with TestClient(create_app(slow_tools)) as c:

        def kill_when_all_running(e, client, tid):
            if e.type == "tool.started" and e.payload.agent_id == "research#3":
                assert client.post(f"/tasks/{tid}/kill").status_code == 202

        ev = run(c, COMPARE, on_event=kill_when_all_running)
    assert ev[-1].type == "execution.failed" and ev[-1].payload.error == "killed by user"
    assert ev[-1].payload.agent_id.startswith("research#")
    started = {e.payload.call_id for e in ev if e.type == "tool.started"}
    closed = {e.payload.call_id for e in ev if e.type in ("tool.completed", "tool.failed")}
    assert started <= closed
    assert sum(1 for e in ev if e.type == "tool.failed" and "cancelled" in e.payload.error) >= 2


def test_model_semaphore_shared_across_runs(slow_tools):
    """Two runs at once still never put two model calls on the GPU together."""
    with TestClient(create_app(slow_tools)) as c:
        llm = CountingLLM(c.app.state.executor._deps.llm)
        c.app.state.executor._deps.llm = llm
        with c.websocket_connect("/ws") as ws:
            ids = {
                c.post("/tasks", json={"prompt": p}).json()["task_id"]
                for p in (COMPARE, "Who chairs the Zephyr Harbor Authority?")
            }
            done = set()
            while done != ids:
                e = parse_event(ws.receive_text())
                if e.type.startswith("execution."):
                    done.add(e.task_id)
    assert llm.max_inflight == 1


def test_asyncio_semaphore_is_per_executor():
    sems = []
    for _ in range(2):
        from app.agent_runtime.pipeline import Deps

        sems.append(Deps(llm=None, tools=None, agents=None).model_sem)  # type: ignore[arg-type]
    assert sems[0] is not sems[1] and isinstance(sems[0], asyncio.Semaphore)
