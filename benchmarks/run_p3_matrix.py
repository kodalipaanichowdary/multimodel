"""G3.12 model matrix: 3 models x 36 prompts (4 roles), deterministic golden rubric 1-5.

Roles and what is measured (same production prompts / schemas / healing as the runtime):
  planner   Plan with PLANNER_SYSTEM; golden = number of research branches + entity terms in queries
  research  person/organization/year extraction; golden = exact fields
  writer    Draft with WRITER_SYSTEM over given SOURCES; golden facts + the real grounding validator;
            unanswerable cases must hedge ("could not verify")
  reasoning short numeric word problems; golden = exact number

Rubric (deterministic, no LLM judge):
  1 = no valid output after the healing retry (or provider error)
  2 = valid JSON, golden answer wrong
  3 = valid, partly right (some fields / facts / terms)
  4 = right, but only after the healing retry, or right with a minor miss (writer: validator flag)
  5 = right on the first try
Per model also: VRAM / GPU share (Ollama /api/ps after the first call), TTFT, tok/s, schema %.

Precondition (ENV RULES): `npm run doctor` green AND free RAM >= 6 GiB. The script checks RAM itself
and refuses to run below 6 GiB unless --force. It never starts Ollama.

    apps/api/.venv/Scripts/python benchmarks/run_p3_matrix.py [model ...]
Default models: llama3.2:3b phi3.5 mistral:7b. Writes benchmarks/p3_matrix.json + p3_matrix.md.
"""

from __future__ import annotations

import asyncio
import json
import re
import statistics
import sys
import time
from pathlib import Path

import httpx
from pydantic import BaseModel, ConfigDict, Field

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from app.agent_runtime.grounding import HEDGE, Page, validate_draft  # noqa: E402
from app.agent_runtime.heal import generate_typed  # noqa: E402
from app.agent_runtime.pipeline import (  # noqa: E402
    PIPELINE,
    PLANNER_SYSTEM,
    WRITER_SYSTEM,
    _sources_block,
    normalize_plan,
)
from app.models.base import Message  # noqa: E402
from app.models.ollama import OllamaClient  # noqa: E402
from pos_schemas import Draft, ModelProfile, Plan  # noqa: E402

sys.path.insert(0, str(ROOT / "benchmarks"))
from _sys import MIN_FREE_GIB, free_ram_gib, ram_gate, utf8_stdout  # noqa: E402

utf8_stdout()

OLLAMA = "http://127.0.0.1:11434"
DEFAULT_MODELS = ["llama3.2:3b", "phi3.5", "mistral:7b"]
ROLES = ("planner", "research", "writer", "reasoning")


class _S(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Extraction(_S):
    person: str = Field(min_length=1)
    organization: str = Field(min_length=1)
    year: int = Field(ge=1000, le=2100)


class Numeric(_S):
    reasoning: str = Field(max_length=600, description="short working")
    answer: float


SYSTEM = {
    "research": "Extract the person, the organization and the year of the main event in the text. JSON only.",
    "reasoning": "Solve the problem. Think briefly in `reasoning`, then give the final number in `answer`. JSON only.",
}


# ------------------------------------------------------------------ scoring (pure, unit-tested)


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9.,& ]+", " ", s.lower()).strip()


def score_planner(plan: Plan | None, golden: dict, prompt: str) -> tuple[int, str]:
    if plan is None:
        return 1, "invalid"
    branches = normalize_plan(plan, prompt)
    text = " ".join([plan.search_query, *(b.query for b in branches)]).lower()
    terms_ok = all(t in text for t in golden["terms"])
    count_ok = len(branches) == golden["branches"]
    ids = {b.step_id for b in branches}
    w = next((s for s in plan.steps if s.agent_id == "writer"), None)
    shape_ok = (
        w is not None
        and any(s.agent_id == "validator" for s in plan.steps)
        and (not w.depends_on or ids <= set(w.depends_on))
    )
    note = f"branches={len(branches)}/{golden['branches']} terms={'ok' if terms_ok else 'miss'} shape={'ok' if shape_ok else 'miss'}"
    if count_ok and terms_ok:
        return (5 if shape_ok else 4), note
    if count_ok or terms_ok:
        return 3, note
    return 2, note


def score_research(x: Extraction | None, golden: dict) -> tuple[int, str]:
    if x is None:
        return 1, "invalid"
    hits = [
        _norm(x.person) == _norm(golden["person"]),
        _norm(x.organization).removeprefix("the ")
        == _norm(golden["organization"]).removeprefix("the "),
        x.year == golden["year"],
    ]
    k = sum(hits)
    return (5 if k == 3 else 3 if k else 2), f"{k}/3 fields"


def score_writer(d: Draft | None, golden: dict, pages: list[Page], prompt: str) -> tuple[int, str]:
    if d is None:
        return 1, "invalid"
    if golden.get("unanswerable"):
        hedged = HEDGE.search(d.answer) is not None
        return (5 if hedged else 2), ("hedged" if hedged else "answered an unanswerable question")
    _, verdict, _ = validate_draft(d, pages, prompt)
    found = [f for f in golden["facts"] if f.lower() in d.answer.lower()]
    note = f"facts {len(found)}/{len(golden['facts'])} validator={'pass' if verdict.passed else 'fail'}"
    if len(found) == len(golden["facts"]):
        return (5 if verdict.passed else 4), note
    return (3 if found else 2), note


def score_reasoning(n: Numeric | None, golden: dict) -> tuple[int, str]:
    if n is None:
        return 1, "invalid"
    ok = abs(n.answer - golden["answer"]) < 1e-6
    return (5 if ok else 2), f"answer={n.answer:g} golden={golden['answer']}"


def apply_heal_cap(score: int, attempts: int) -> int:
    """A right answer that needed the healing retry is a 4, not a 5."""
    return min(score, 4) if attempts > 1 and score == 5 else score


# ------------------------------------------------------------------ runner


async def ps_vram(model: str) -> dict:
    async with httpx.AsyncClient(timeout=10) as http:
        for m in (await http.get(f"{OLLAMA}/api/ps")).json().get("models", []):
            if m.get("name", "").split(":")[0] == model.split(":")[0]:
                size, vram = m.get("size", 0), m.get("size_vram", 0)
                return {
                    "vram_gib": round(vram / 2**30, 2),
                    "size_gib": round(size / 2**30, 2),
                    "gpu_share": round(vram / size, 2) if size else 0.0,
                }
    return {"vram_gib": None, "size_gib": None, "gpu_share": None}


async def unload(model: str) -> None:
    async with httpx.AsyncClient(timeout=30) as http:
        await http.post(f"{OLLAMA}/api/generate", json={"model": model, "keep_alive": 0})


async def one(client: OllamaClient, model: str, p: dict) -> dict:
    role = p["role"]
    profile = ModelProfile(model=model, temperature=0, max_tokens=512)
    pages: list[Page] = []
    context = None
    if role == "planner":
        cls, schema = Plan, Plan.model_json_schema()
        schema["$defs"]["PlanStep"]["properties"]["agent_id"]["enum"] = list(PIPELINE)
        msgs = [Message("system", PLANNER_SYSTEM), Message("user", f"TASK: {p['prompt']}")]
        context = {"allowed_agents": set(PIPELINE)}
    elif role == "writer":
        pages = [Page(i, s["url"], s["title"], s["text"]) for i, s in enumerate(p["sources"], 1)]
        cls, schema = Draft, Draft.model_json_schema()
        msgs = [
            Message("system", WRITER_SYSTEM),
            Message("user", f"TASK: {p['prompt']}\n\nSOURCES:\n{_sources_block(pages)}"),
        ]
        context = {"n_sources": len(pages)}
    else:
        cls = Extraction if role == "research" else Numeric
        schema = cls.model_json_schema()
        msgs = [Message("system", SYSTEM[role]), Message("user", p["prompt"])]
    t0 = time.perf_counter()
    try:
        h = await generate_typed(
            client, profile, msgs, cls, lambda: None, schema=schema, context=context
        )  # type: ignore[arg-type,return-value]
        err = None
    except Exception as e:  # provider error counts as score 1, never crashes the matrix
        h, err = None, f"{type(e).__name__}: {e}"[:200]
    value = h.value if h and not h.fell_back else None
    if role == "planner":
        s, note = score_planner(value, p["golden"], p["prompt"])
    elif role == "research":
        s, note = score_research(value, p["golden"])
    elif role == "writer":
        s, note = score_writer(value, p["golden"], pages, p["prompt"])
    else:
        s, note = score_reasoning(value, p["golden"])
    attempts = h.attempts if h else 0
    m0 = h.metrics[0] if h and h.metrics else None
    return {
        "id": p["id"],
        "role": role,
        "score": apply_heal_cap(s, attempts),
        "note": err or note,
        "first_try_valid": bool(h and attempts == 1 and not h.fell_back),
        "valid_after_heal": value is not None,
        "ttft_ms": m0.ttft_ms if m0 else None,
        "tok_s": m0.tok_s if m0 else None,
        "total_ms": round((time.perf_counter() - t0) * 1000),
    }


def summarize(model: str, rows: list[dict], vram: dict) -> dict:
    warm = [r for r in rows[1:] if r["ttft_ms"] is not None] or rows

    def med(k: str) -> float | None:
        xs = [r[k] for r in warm if r[k] is not None]
        return round(statistics.median(xs), 1) if xs else None

    by_role = {
        role: round(statistics.mean([r["score"] for r in rows if r["role"] == role]), 2)
        for role in ROLES
        if any(r["role"] == role for r in rows)
    }
    return {
        "model": model,
        "n": len(rows),
        **vram,
        "schema_first_try": round(sum(r["first_try_valid"] for r in rows) / len(rows), 4),
        "schema_after_heal": round(sum(r["valid_after_heal"] for r in rows) / len(rows), 4),
        "mean_score": round(statistics.mean(r["score"] for r in rows), 2),
        "score_by_role": by_role,
        "cold_ttft_ms": rows[0]["ttft_ms"],
        "median_ttft_ms_warm": med("ttft_ms"),
        "median_tok_s_warm": med("tok_s"),
        "median_total_ms_warm": med("total_ms"),
        "rows": rows,
    }


def recommend(results: list[dict]) -> dict[str, dict]:
    """Per role: best mean score; ties (within 0.25) go to the faster model; models that do not fit
    mostly on the GPU (gpu_share < 0.8) lose ties too, since they slow every other call."""
    out = {}
    for role in ROLES:
        cands = [r for r in results if role in r["score_by_role"]]
        if not cands:
            continue
        best = max(r["score_by_role"][role] for r in cands)
        close = [r for r in cands if r["score_by_role"][role] >= best - 0.25]
        close.sort(key=lambda r: ((r["gpu_share"] or 0) < 0.8, r["median_total_ms_warm"] or 1e9))
        pick = close[0]
        out[role] = {
            "model": pick["model"],
            "score": pick["score_by_role"][role],
            "best_score": best,
        }
    return out


def markdown(results: list[dict], rec: dict, meta: dict) -> str:
    out = [
        "# P3 model matrix (G3.12)",
        "",
        f"{meta['when']} | {meta['n_prompts']} prompts/model ({meta.get('roles', '')}) | T=0 | "
        f"production prompts + schemas + one healing retry | free RAM at start {meta['free_ram_gib']} GiB",
        "",
        "Rubric (deterministic): 1 invalid after heal | 2 valid, wrong | 3 partly right | 4 right after heal or minor miss | 5 right first try",
        "",
        "| model | VRAM GiB | GPU share | schema 1st try | schema after heal | mean score | planner | research | writer | reasoning | cold TTFT | median TTFT | median tok/s | median total |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for r in results:
        sr = r["score_by_role"]
        out.append(
            f"| {r['model']} | {r['vram_gib']} | {r['gpu_share']} | {r['schema_first_try']:.0%} | {r['schema_after_heal']:.0%} | "
            f"{r['mean_score']} | {sr.get('planner')} | {sr.get('research')} | {sr.get('writer')} | {sr.get('reasoning')} | "
            f"{r['cold_ttft_ms']} ms | {r['median_ttft_ms_warm']} ms | {r['median_tok_s_warm']} | {r['median_total_ms_warm']} ms |"
        )
    out += [f"| {m} | skipped: {why} |" + " |" * 12 for m, why in meta.get("skipped", {}).items()]
    out += [
        "",
        "## Recommendation per role",
        "",
        "| role | model | score | best score |",
        "|---|---|---|---|",
    ]
    out += [
        f"| {role} | {v['model']} | {v['score']} | {v['best_score']} |" for role, v in rec.items()
    ]
    out += ["", "## Misses (score < 5)", ""]
    for r in results:
        misses = [x for x in r["rows"] if x["score"] < 5]
        out.append(
            f"- **{r['model']}**: "
            + ("; ".join(f"{x['id']}={x['score']} ({x['note']})" for x in misses) or "none")
        )
    return "\n".join(out) + "\n"


async def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    free = ram_gate(force="--force" in sys.argv)
    if free is None:
        return 2
    opts = dict(a[2:].split("=", 1) for a in sys.argv[1:] if a.startswith("--") and "=" in a)
    out_name = opts.get("out", "p3_matrix")  # e.g. --out=p3_planner_after (partial reruns)
    prompts = json.loads((ROOT / "benchmarks" / "prompts_p3.json").read_text(encoding="utf-8"))
    assert 30 <= len(prompts) <= 50, len(prompts)
    if "roles" in opts:  # e.g. --roles=planner ; a partial run must not overwrite the full matrix
        prompts = [p for p in prompts if p["role"] in opts["roles"].split(",")]
        assert out_name != "p3_matrix", "--roles needs --out=<other name>"
    models = args or DEFAULT_MODELS
    client = OllamaClient(OLLAMA, timeout_s=300)
    try:
        have = await client.list_models()
    except Exception as e:
        print(
            f"Ollama is not reachable ({type(e).__name__}). Start the Ollama tray app, then rerun."
        )
        return 2
    missing = [m for m in models if m not in have and f"{m}:latest" not in have]
    if missing:
        print("Missing models. Run:\n" + "\n".join(f"  ollama pull {m}" for m in missing))
        return 2
    results, skipped = [], {}
    for model in models:
        print(f"== {model}", flush=True)
        # re-check before each model; Ollama frees the previous model a few seconds after unload
        for _ in range(60):
            if free_ram_gib() >= MIN_FREE_GIB:
                break
            await asyncio.sleep(1)
        if ram_gate() is None:
            skipped[model] = "free RAM < 6 GiB before this model (waited 60 s)"
            continue
        rows, vram = [], None
        for p in prompts:
            rows.append(await one(client, model, p))
            if vram is None:
                vram = await ps_vram(model)
                print(f"   loaded: {vram}", flush=True)
                if vram.get("gpu_share") == 0:  # ENV RULES: 100% CPU -> stop this item
                    skipped[model] = (
                        "ollama ps shows 100% CPU; start the Ollama tray app (GPU) and rerun"
                    )
                    print(f"   STOP: {skipped[model]}", flush=True)
                    break
            r = rows[-1]
            print(
                f"   {r['id']} {r['role']:9s} score={r['score']} ttft={r['ttft_ms']} tok/s={r['tok_s']} {r['note']}",
                flush=True,
            )
        if model in skipped:
            await unload(model)
            continue
        results.append(summarize(model, rows, vram or {}))
        await unload(model)
    rec = recommend(results)
    meta = {
        "when": time.strftime("%Y-%m-%d %H:%M:%S"),
        "n_prompts": len(prompts),
        "roles": ", ".join(
            f"{r} {sum(p['role'] == r for p in prompts)}"
            for r in ROLES
            if any(p["role"] == r for p in prompts)
        ),
        "free_ram_gib": free,
        "skipped": skipped,
    }
    (ROOT / "benchmarks" / f"{out_name}.json").write_text(
        json.dumps({"meta": meta, "recommendation": rec, "results": results}, indent=1),
        encoding="utf-8",
    )
    md = markdown(results, rec, meta)
    (ROOT / "benchmarks" / f"{out_name}.md").write_text(md, encoding="utf-8")
    print("\n" + md)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
