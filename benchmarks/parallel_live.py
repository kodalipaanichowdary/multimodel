"""G3.6 live check: the same multi-part question, PARALLEL_BRANCHES=1 vs 0, real Ollama + web.

Reports the research-stage wall time of each mode, the ratio, the peak number of branches
running at once, and model-call overlap (must stay 1 with MODEL_CONCURRENCY=1).
Speed-up comes from overlapping tool I/O; model calls still queue on one GPU.

    apps/api/.venv/Scripts/python benchmarks/parallel_live.py ["prompt"]
Writes benchmarks/p3_parallel_live.json.
"""

from __future__ import annotations

import json
import sys
import time
from dataclasses import replace
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from app.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from pos_schemas import parse_event  # noqa: E402

PROMPT = "Compare the populations of Hyderabad, Bangalore and Chennai"


class Counting:
    def __init__(self, inner):
        self.inner, self.name = inner, inner.name
        self.inflight = self.max_inflight = 0

    async def generate(self, profile, messages, schema):
        self.inflight += 1
        self.max_inflight = max(self.max_inflight, self.inflight)
        try:
            return await self.inner.generate(profile, messages, schema)
        finally:
            self.inflight -= 1


def run(parallel: bool, prompt: str) -> dict:
    s = replace(Settings(), db_path=":memory:", mock_executor=False, parallel_branches=parallel)
    with TestClient(create_app(s)) as c:
        llm = Counting(c.app.state.executor._deps.llm)
        c.app.state.executor._deps.llm = llm
        t0 = time.perf_counter()
        with c.websocket_connect("/ws") as ws:
            tid = c.post("/tasks", json={"prompt": prompt}).json()["task_id"]
            ev = []
            while True:
                e = parse_event(ws.receive_text())
                if e.task_id == tid:
                    ev.append(e)
                    if e.type.startswith("execution."):
                        break
        total = time.perf_counter() - t0
    ts = lambda e: datetime.fromisoformat(str(e.ts)).timestamp()  # noqa: E731
    st = {
        e.payload.agent_id: ts(e)
        for e in ev
        if e.type == "agent.started" and e.payload.agent_id.startswith("research")
    }
    en = {
        e.payload.agent_id: ts(e)
        for e in ev
        if e.type == "agent.completed" and e.payload.agent_id.startswith("research")
    }
    marks = sorted([(st[a], 1) for a in st] + [(en[a], -1) for a in en])
    peak = cur = 0
    for _, d in marks:
        cur += d
        peak = max(peak, cur)
    plan = next(e for e in ev if e.type == "task.planned").payload.steps
    answer = next((e.payload.content for e in ev if e.type == "artifact.created"), "")
    return {
        "parallel": parallel,
        "branches": [s.agent_id for s in plan if s.agent_id.startswith("research")],
        "queries": [s.query for s in plan if s.agent_id.startswith("research")],
        "research_wall_s": round(max(en.values()) - min(st.values()), 2) if st and en else None,
        "branch_spans_s": {a: round(en[a] - st[a], 2) for a in st if a in en},
        "peak_concurrent_branches": peak,
        "max_model_calls_in_flight": llm.max_inflight,
        "total_s": round(total, 1),
        "terminal": ev[-1].type,
        "answer_head": answer.splitlines()[0][:200] if answer else "",
    }


def main() -> None:
    prompt = sys.argv[1] if len(sys.argv) > 1 else PROMPT
    par = run(True, prompt)
    seq = run(False, prompt)
    ratio = (
        round(par["research_wall_s"] / seq["research_wall_s"], 2)
        if par["research_wall_s"] and seq["research_wall_s"]
        else None
    )
    out = {
        "when": time.strftime("%Y-%m-%d %H:%M:%S"),
        "prompt": prompt,
        "parallel": par,
        "sequential": seq,
        "ratio_parallel_over_sequential": ratio,
    }
    (ROOT / "benchmarks" / "p3_parallel_live.json").write_text(
        json.dumps(out, indent=1), encoding="utf-8"
    )
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
