"""G2.6 soak: 20 consecutive REAL runs (Ollama + live web), zero unhandled exceptions.

"Unhandled" is counted three ways: the executor's last-line-of-defence counter, any ERROR log
record from the app, and asyncio's "exception was never retrieved" (also an ERROR log).
Handled outcomes (grounded / could-not-verify / model unavailable) are reported, not hidden.

    apps/api/.venv/Scripts/python benchmarks/soak_p2.py [N]
Writes benchmarks/p2_soak.json.
"""

from __future__ import annotations

import json
import logging
import sys
import time
from dataclasses import replace
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from app.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from pos_schemas import parse_event  # noqa: E402

PROMPTS = [
    "who is cm of telangana",
    "What is the capital of Australia?",
    "Who wrote the novel Pride and Prejudice?",
    "What is the Model Context Protocol?",
    "How tall is Mount Everest?",
    "Who is the current CEO of Microsoft?",
    "What year did the first human land on the Moon?",
    "What is the boiling point of water at sea level in Celsius?",
    "Who painted the Mona Lisa?",
    "What is the population of Hyderabad?",
]


class Errors(logging.Handler):
    def __init__(self) -> None:
        super().__init__(logging.ERROR)
        self.records: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(f"{record.name}: {record.getMessage()[:300]}")


def main(n: int) -> None:
    errors = Errors()
    logging.getLogger().addHandler(errors)
    s = replace(Settings(), db_path=":memory:", mock_executor=False, llm_provider="ollama")
    runs = []
    with TestClient(create_app(s)) as c:
        for i in range(n):
            prompt = PROMPTS[i % len(PROMPTS)]
            t0 = time.perf_counter()
            with c.websocket_connect("/ws") as ws:
                tid = c.post("/tasks", json={"prompt": prompt}).json()["task_id"]
                ev = []
                while True:
                    e = parse_event(ws.receive_text())
                    if e.task_id != tid:
                        continue
                    ev.append(e)
                    if e.type.startswith("execution."):
                        break
            answer = next((e.payload.content for e in ev if e.type == "artifact.created"), "")
            status = next(
                (
                    e.payload.summary
                    for e in ev
                    if e.type == "agent.completed" and e.payload.agent_id == "orchestrator"
                ),
                "",
            )
            heals = sum(1 for e in ev if e.type == "model.metrics" and e.payload.attempt > 1)
            runs.append(
                {
                    "i": i + 1,
                    "prompt": prompt,
                    "terminal": ev[-1].type,
                    "error": getattr(ev[-1].payload, "error", None),
                    "outcome": status.removeprefix("done (").removesuffix(")") if status else None,
                    "seconds": round(time.perf_counter() - t0, 1),
                    "events": len(ev),
                    "heal_retries": heals,
                    "answer_head": answer.splitlines()[0][:160] if answer else "",
                }
            )
            r = runs[-1]
            print(
                f"{r['i']:>2} {r['terminal']:20s} {r['outcome']!s:11s} {r['seconds']:6.1f}s heals={heals} | {prompt[:40]:40s} | {r['answer_head'][:90]}",
                flush=True,
            )
        unhandled = c.app.state.executor.unhandled
    summary = {
        "when": time.strftime("%Y-%m-%d %H:%M:%S"),
        "runs": n,
        "completed": sum(r["terminal"] == "execution.completed" for r in runs),
        "failed_handled": sum(r["terminal"] == "execution.failed" for r in runs),
        "outcomes": {
            k: sum(r["outcome"] == k for r in runs)
            for k in sorted({str(r["outcome"]) for r in runs})
        },
        "unhandled_executor_counter": unhandled,
        "error_log_records": errors.records,
        "median_seconds": sorted(r["seconds"] for r in runs)[n // 2],
        "runs_detail": runs,
    }
    (ROOT / "benchmarks" / "p2_soak.json").write_text(
        json.dumps(summary, indent=1), encoding="utf-8"
    )
    print(json.dumps({k: v for k, v in summary.items() if k != "runs_detail"}, indent=1))


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 20)
