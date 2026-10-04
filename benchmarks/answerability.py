"""Q.0 answerability scorer: live runs of benchmarks/answerability.json, scored deterministically.

Each run is scored correct / wrong / unverified (compares: full / partial / wrong / unverified,
per item). No self-judging: expected substrings and numeric ranges only.

    apps/api/.venv/Scripts/python benchmarks/answerability.py --label baseline1
    ... --holdout            run ONLY the 10 holdout rows (once, at the end)
    ... --only f01,n02       subset (debugging; not gate evidence)
    ... --stub               deterministic stub model + offline corpus (harness smoke only)

Precondition (ENV RULES, phase Q): doctor green, free RAM >= 7 GiB (checked; --force overrides).
Never starts Ollama. Writes benchmarks/answerability_<label>.json.
"""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile
import time
from dataclasses import replace
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))
sys.path.insert(0, str(ROOT / "benchmarks"))

from _sys import free_ram_gib, keep_awake, utf8_stdout  # noqa: E402

utf8_stdout()
keep_awake()

MIN_FREE_GIB_Q = 7.0
STUB = "--stub" in sys.argv
if STUB:  # before the app imports read the env
    os.environ.update(SEARCH_PROVIDER="stub", FETCH_PROVIDER="stub")

from app.agent_runtime.grounding import HEDGE  # noqa: E402
from app.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from pos_schemas import parse_event  # noqa: E402

UNVERIFIED_STATUS = {"unverified", "no_sources", "hedged", "memory_failed"}
NUM = re.compile(
    r"(?<![\w.])(\d{1,3}(?:[,\u00a0\u202f\u2009]\d{3})+|\d+)(?:\.(\d+))?"
    r"(?:\s*(million|billion|thousand|crore|lakh)\b)?",
    re.I,
)
SCALE = {"thousand": 1e3, "million": 1e6, "billion": 1e9, "lakh": 1e5, "crore": 1e7}
CITE = re.compile(r"\[\d+\]")
SENT = re.compile(r"(?<=[.!?;])\s+|\n+")


# ------------------------------------------------------------------ scoring helpers (pure)
def body_of(content: str) -> str:
    """Answer text without the Sources list and without [n] markers."""
    head = re.split(r"\*\*Sources", content, maxsplit=1)[0]
    return CITE.sub("", head)


def numbers_in(text: str) -> list[float]:
    out = []
    for m in NUM.finditer(text):
        whole = re.sub(r"[,\u00a0\u202f\u2009]", "", m.group(1))
        v = float(f"{whole}.{m.group(2)}" if m.group(2) else whole)
        if m.group(3):
            v *= SCALE[m.group(3).lower()]
        out.append(v)
    return out


def in_range(text: str, rng: list[float]) -> bool:
    lo, hi = rng
    return any(lo - 1e-9 <= v <= hi + 1e-9 for v in numbers_in(text))


def has_expect(text: str, expect: list[str], word: bool = False) -> bool:
    for e in expect:
        pat = rf"\b{re.escape(e)}\b" if word else re.escape(e)
        if re.search(pat, text, re.I if not word else 0):
            return True
    return False


def score_single(q: dict, status: str, content: str) -> str:
    if status == "failed":
        return "failed"
    if q["cat"] == "unanswerable":
        return "correct" if status in UNVERIFIED_STATUS or HEDGE.search(content) else "wrong"
    if status in UNVERIFIED_STATUS or not content:
        return "unverified"
    body = body_of(content)
    if HEDGE.search(body) and not (
        ("range" in q and in_range(body, q["range"]))
        or ("expect" in q and has_expect(body, q["expect"], q.get("word", False)))
    ):
        return "unverified"
    if "range" in q:
        return "correct" if in_range(body, q["range"]) else "wrong"
    return "correct" if has_expect(body, q["expect"], q.get("word", False)) else "wrong"


def score_item(item: dict, body: str) -> str:
    sents = [s for s in SENT.split(body) if re.search(re.escape(item["name"]), s, re.I)]
    if not sents:
        return "omitted"
    if any(in_range(s, item["range"]) for s in sents):
        return "correct"
    if any(HEDGE.search(s) for s in sents):
        return "unverified"
    if any(numbers_in(s) for s in sents):
        return "wrong"
    return "unverified"  # named without a figure: no claim made


def score_compare(q: dict, status: str, content: str) -> tuple[str, dict]:
    if status == "failed":
        return "failed", {}
    if status in {"unverified", "no_sources"} or not content:
        return "unverified", {i["name"]: "unverified" for i in q["items"]}
    body = body_of(content)
    items = {i["name"]: score_item(i, body) for i in q["items"]}
    vals = list(items.values())
    if "wrong" in vals:
        return "wrong", items
    if all(v == "correct" for v in vals):
        return "full", items
    if "correct" in vals:
        return "partial", items
    return "unverified", items


# ------------------------------------------------------------------ live run
def run_task(c: TestClient, prompt: str, project: str | None) -> dict:
    body: dict = {"prompt": prompt}
    if project:
        body["project_id"] = project
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
                c.post(f"/approvals/{e.payload.approval_id}", json={"decision": "deny"})
            if e.type.startswith("execution."):
                break
    content = next((e.payload.content for e in ev if e.type == "artifact.created"), "")
    status = ""
    for e in ev:
        if e.type == "agent.completed" and e.payload.agent_id == "orchestrator":
            m = re.search(r"done \((\w+)\)", e.payload.summary or "")
            status = m.group(1) if m else status
    if ev[-1].type == "execution.failed":
        status = "failed"
    planned = next((e.payload.steps for e in ev if e.type == "task.planned"), [])
    diag = {
        "planned_steps": len(planned),
        "research_branches": sum(1 for s in planned if s.agent_id.startswith("research")),
        "queries": [getattr(s, "query", None) for s in planned if getattr(s, "query", None)],
        "fetch_urls": [
            e.payload.args.get("url")
            for e in ev
            if e.type == "tool.started" and e.payload.tool_id == "fetch_url"
        ],
        "tool_failed": [
            f"{e.payload.tool_id}: {str(e.payload.error)[:160]}"
            for e in ev
            if e.type == "tool.failed"
        ],
        "model_calls": [
            f"{e.payload.agent_id}#{e.payload.attempt} {e.payload.model} {e.payload.total_ms}ms "
            f"{e.payload.completion_tokens}tok"
            for e in ev
            if e.type == "model.metrics"
        ],
        "heal_retries": sum(1 for e in ev if e.type == "model.metrics" and e.payload.attempt > 1),
        "fallbacks": sum(
            1 for e in ev if e.type == "agent.thinking" and "fallback" in (e.payload.message or "")
        ),
        "validator": [
            e.payload.message[:500]
            for e in ev
            if e.type == "agent.thinking"
            and e.payload.agent_id == "validator"
            and not e.payload.message.startswith("Checking")
        ],
        "summaries": [
            f"{e.payload.agent_id}: {e.payload.summary}"[:200]
            for e in ev
            if e.type == "agent.completed"
        ],
        "error": getattr(ev[-1].payload, "error", None),
    }
    return {
        "task_id": tid,
        "status": status,
        "seconds": round(time.perf_counter() - t0, 1),
        "content": content,
        "diag": diag,
    }


def summarize(rows: list[dict]) -> dict:
    cats: dict[str, dict] = {}
    for r in rows:
        d = cats.setdefault(r["cat"], {})
        d[r["score"]] = d.get(r["score"], 0) + 1
        d["n"] = d.get("n", 0) + 1
    golden = [r for r in rows if r.get("golden")]
    answerable = [r for r in rows if r["cat"] != "unanswerable"]
    wrong = sum(r["score"] == "wrong" for r in rows)
    ans_unv = sum(r["score"] in ("unverified",) for r in answerable)
    cmp_rows = [r for r in rows if r["cat"] == "compare"]
    num_rows = [r for r in rows if r["cat"] == "numeric"]
    un_rows = [r for r in rows if r["cat"] == "unanswerable"]
    pct = lambda a, b: round(100 * a / b, 1) if b else None  # noqa: E731
    return {
        "per_category": cats,
        "metrics": {
            "golden_correct": f"{sum(r['score'] == 'correct' for r in golden)}/{len(golden)}",
            "numeric_correct_pct": pct(
                sum(r["score"] == "correct" for r in num_rows), len(num_rows)
            ),
            "compare_full_or_partial_pct": pct(
                sum(r["score"] in ("full", "partial") for r in cmp_rows), len(cmp_rows)
            ),
            "compare_wrong": sum(r["score"] == "wrong" for r in cmp_rows),
            "wrong_rate_pct": pct(wrong, len(rows)),
            "unanswerable_refused_pct": pct(
                sum(r["score"] == "correct" for r in un_rows), len(un_rows)
            ),
            "answerable_unverified_pct": pct(ans_unv, len(answerable)),
        },
    }


def main() -> int:
    args = sys.argv[1:]
    label = args[args.index("--label") + 1] if "--label" in args else time.strftime("run%Y%m%d%H%M")
    only = set(args[args.index("--only") + 1].split(",")) if "--only" in args else None
    holdout = "--holdout" in args
    free = round(free_ram_gib(), 1)
    if not STUB and free < MIN_FREE_GIB_Q and "--force" not in args:
        print(f"REFUSED: free RAM {free} GiB < {MIN_FREE_GIB_Q} GiB. Close large apps and rerun.")
        return 2
    spec = json.loads((ROOT / "benchmarks" / "answerability.json").read_text(encoding="utf-8"))
    qs = [q for q in spec["questions"] if bool(q.get("holdout")) == holdout]
    if only:
        qs = [q for q in spec["questions"] if q["id"] in only]
    tmp = Path(tempfile.mkdtemp(prefix="pos-answer-"))
    s = replace(
        Settings(),
        mock_executor=False,
        llm_provider="stub" if STUB else "ollama",
        stub_delay_s=0.0,
        db_path=str(tmp / "pos.db"),
        memory_db_path=str(tmp / "memory.db"),
        audit_db_path=str(tmp / "audit.db"),
        traces_dir=str(tmp / "traces"),
        approval_timeout_s=5,
        cors_origins=[],
    )
    os.environ.setdefault("FS_WRITE_ROOT", str(tmp / "artifacts"))
    rows = []
    t_all = time.perf_counter()
    with TestClient(create_app(s)) as c:
        for q in qs:
            reps = spec.get("golden_repeats", 1) if q.get("golden") and not only else 1
            for rep in range(reps):
                if q.get("setup") and rep == 0:
                    run_task(c, q["setup"], q.get("project"))
                r = run_task(c, q["prompt"], q.get("project"))
                if q["cat"] == "compare":
                    r["score"], r["items"] = score_compare(q, r["status"], r["content"])
                else:
                    r["score"] = score_single(q, r["status"], r["content"])
                r.update(id=q["id"], cat=q["cat"], rep=rep + 1, golden=bool(q.get("golden")))
                rows.append(r)
                head = body_of(r["content"]).strip().replace("\n", " ")[:90]
                print(
                    f"{q['id']}#{rep + 1:<2} {q['cat']:12s} {r['score']:10s} {r['status']:10s} "
                    f"{r['seconds']:6.1f}s br={r['diag']['research_branches']} "
                    f"tf={len(r['diag']['tool_failed'])} | {head}",
                    flush=True,
                )
    summary = {
        "label": label,
        "when": time.strftime("%Y-%m-%d %H:%M:%S"),
        "mode": "stub (smoke, not evidence)" if STUB else "live (Ollama + live web)",
        "set": "holdout" if holdout else ("subset" if only else "non-holdout"),
        "free_ram_gib_at_start": free,
        "total_seconds": round(time.perf_counter() - t_all, 1),
        **summarize(rows),
        "runs": rows,
    }
    out = ROOT / "benchmarks" / f"answerability_{label}.json"
    out.write_text(json.dumps(summary, indent=1, ensure_ascii=True), encoding="utf-8")
    print(json.dumps({k: v for k, v in summary.items() if k != "runs"}, indent=1))
    print(f"wrote {out.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
