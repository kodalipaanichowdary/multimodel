"""G3.13 soak: 50 mixed REAL tasks (Ollama + live web) in one API process.

Mix (cycled): single facts, multi-part comparisons (parallel branches), remember + recall in a
project, an fs_write that needs approval (allowed and denied alternately), a non-private task,
and a task with no web answer. Approvals are answered by the script like a user would.

Gate: >= 95% of runs end execution.completed (grounded OR honestly "could not verify"),
0 unhandled (executor counter + ERROR log records), RSS growth < 20% (after 5 warm-up runs ->
end), audit chain still verifies, one trace file per run.

Precondition (ENV RULES): doctor green and free RAM >= 6 GiB (checked; --force overrides).
Never starts Ollama.

    apps/api/.venv/Scripts/python benchmarks/soak_p3.py [N] [--stub]
--stub uses the deterministic stub model + offline corpus (harness smoke only, NOT gate evidence).
Writes benchmarks/p3_soak.json (or p3_soak_stub.json).
"""

from __future__ import annotations

import gc
import json
import logging
import os
import sys
import tempfile
import time
from dataclasses import replace
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))
sys.path.insert(0, str(ROOT / "benchmarks"))

from _sys import free_ram_gib, ram_gate, rss_mib, utf8_stdout  # noqa: E402

utf8_stdout()

STUB = "--stub" in sys.argv
if STUB:  # before the app imports read the env
    os.environ.update(SEARCH_PROVIDER="stub", FETCH_PROVIDER="stub")

from app.agent_runtime.grounding import HEDGE  # noqa: E402
from app.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from pos_schemas import parse_event  # noqa: E402

# (prompt, options) ; options: project, private, approval ("allow" | "deny")
MIX: list[tuple[str, dict]] = [
    ("What is the capital of Australia?", {}),
    ("Compare the populations of Lyon, Marseille and Nice", {}),
    ("Remember that the soak project codename is Heron", {"project": "soak"}),
    ("What is the soak project codename?", {"project": "soak"}),
    ("Who wrote the novel Pride and Prejudice? Save the answer to a file", {"approval": "allow"}),
    ("How tall is Mount Everest?", {"private": False}),
    ("Compare Python and Rust for writing command-line tools", {}),
    (
        "What is the boiling point of water at sea level in Celsius? Save the answer to a file",
        {"approval": "deny"},
    ),
    ("What did the Glorbnax Committee decide on 31 February 2031?", {}),
    ("Who painted the Mona Lisa?", {}),
]
STUB_MIX: list[tuple[str, dict]] = [
    ("Who chairs the Zephyr Harbor Authority?", {}),
    ("Compare Zephyr Harbor, Quillon Library and Marsh Observatory", {}),
    ("Remember that the soak project codename is Heron", {"project": "soak"}),
    ("What is the soak project codename?", {"project": "soak"}),
    ("Research Zephyr and save the answer to a file", {"approval": "allow"}),
    ("When was the Quillon Library founded?", {"private": False}),
    ("Research Zephyr and save the answer to a file", {"approval": "deny"}),
    ("What did the Glorbnax Committee decide?", {}),
]


class Errors(logging.Handler):
    def __init__(self) -> None:
        super().__init__(logging.ERROR)
        self.records: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(f"{record.name}: {record.getMessage()[:300]}")


def run_one(c: TestClient, prompt: str, opt: dict) -> dict:
    body = {"prompt": prompt}
    if "project" in opt:
        body["project_id"] = opt["project"]
    if "private" in opt:
        body["private"] = opt["private"]
    t0 = time.perf_counter()
    with c.websocket_connect("/ws") as ws:
        tid = c.post("/tasks", json=body).json()["task_id"]
        ev = []
        while True:
            e = parse_event(ws.receive_text())
            if e.task_id != tid:
                continue
            ev.append(e)
            if e.type == "approval.requested":
                c.post(
                    f"/approvals/{e.payload.approval_id}",
                    json={"decision": opt.get("approval", "deny")},
                )
            if e.type.startswith("execution."):
                break
    answer = next((e.payload.content for e in ev if e.type == "artifact.created"), "")
    completed = ev[-1].type == "execution.completed"
    return {
        "task_id": tid,
        "prompt": prompt,
        "terminal": ev[-1].type,
        "error": getattr(ev[-1].payload, "error", None),
        "honest_unverified": completed and HEDGE.search(answer) is not None,
        "seconds": round(time.perf_counter() - t0, 1),
        "events": len(ev),
        "tools_failed": sum(e.type == "tool.failed" for e in ev),
        "heal_retries": sum(1 for e in ev if e.type == "model.metrics" and e.payload.attempt > 1),
        "answer_head": answer.splitlines()[0][:140] if answer else "",
    }


def main(n: int) -> int:
    free = round(free_ram_gib(), 1) if STUB else ram_gate(force="--force" in sys.argv)
    if free is None:
        return 2
    errors = Errors()
    logging.getLogger().addHandler(errors)
    tmp = Path(tempfile.mkdtemp(prefix="pos-soak-"))
    s = replace(
        Settings(),
        mock_executor=False,
        llm_provider="stub" if STUB else "ollama",
        stub_delay_s=0.05 if STUB else 0.0,
        db_path=str(tmp / "pos.db"),
        memory_db_path=str(tmp / "memory.db"),
        audit_db_path=str(tmp / "audit.db"),
        traces_dir=str(tmp / "traces"),
        approval_timeout_s=30,
        cors_origins=[],
    )
    os.environ.setdefault("FS_WRITE_ROOT", str(tmp / "artifacts"))
    mix = STUB_MIX if STUB else MIX
    runs, rss = [], {}
    with TestClient(create_app(s)) as c:
        for i in range(n):
            prompt, opt = mix[i % len(mix)]
            r = run_one(c, prompt, opt)
            r["i"] = i + 1
            runs.append(r)
            if i + 1 == min(5, n):
                gc.collect()
                rss["after_warmup_mib"] = round(rss_mib(), 1)
            print(
                f"{r['i']:>2} {r['terminal']:20s} {'unverified' if r['honest_unverified'] else '':10s} "
                f"{r['seconds']:6.1f}s tools_failed={r['tools_failed']} | {prompt[:44]:44s} | {r['answer_head'][:80]}",
                flush=True,
            )
        gc.collect()
        rss["end_mib"] = round(rss_mib(), 1)
        unhandled = c.app.state.executor.unhandled
        audit = c.get("/audit/verify").json()
    traces = len(list((tmp / "traces").glob("*.jsonl")))
    ok = sum(r["terminal"] == "execution.completed" for r in runs)
    growth = (rss["end_mib"] - rss["after_warmup_mib"]) / rss["after_warmup_mib"]
    gate = {
        "completed_or_unverified_ratio": round(ok / n, 4),
        "unhandled": unhandled + len(errors.records),
        "rss_growth": round(growth, 4),
        "audit_chain_ok": audit["ok"],
        "trace_files": traces,
    }
    gate["PASS"] = (
        gate["completed_or_unverified_ratio"] >= 0.95
        and gate["unhandled"] == 0
        and gate["rss_growth"] < 0.20
        and audit["ok"]
        and traces == n
    )
    summary = {
        "when": time.strftime("%Y-%m-%d %H:%M:%S"),
        "mode": "stub (harness smoke, not gate evidence)" if STUB else "real (Ollama + live web)",
        "runs": n,
        "free_ram_gib_at_start": free,
        "gate": gate,
        "completed": ok,
        "honest_unverified": sum(r["honest_unverified"] for r in runs),
        "failed_handled": sum(r["terminal"] == "execution.failed" for r in runs),
        "rss_mib": rss,
        "audit": audit,
        "error_log_records": errors.records,
        "median_seconds": sorted(r["seconds"] for r in runs)[n // 2],
        "runs_detail": runs,
    }
    out = ROOT / "benchmarks" / ("p3_soak_stub.json" if STUB else "p3_soak.json")
    out.write_text(json.dumps(summary, indent=1), encoding="utf-8")
    print(json.dumps({k: v for k, v in summary.items() if k != "runs_detail"}, indent=1))
    return 0 if gate["PASS"] else 1


if __name__ == "__main__":
    nums = [a for a in sys.argv[1:] if a.isdigit()]
    raise SystemExit(main(int(nums[0]) if nums else 50))
