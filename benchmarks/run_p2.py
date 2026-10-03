"""G2.3 benchmark: 30 JSON prompts x each Ollama model, T=0, schema-constrained.

Measures per call: TTFT (streamed), tok/s (Ollama eval counters), total latency, whether the
first reply validated (schema accuracy), whether the one healing retry fixed it.

    apps/api/.venv/Scripts/python benchmarks/run_p2.py            # all models in agents/*/manifest.yaml
    apps/api/.venv/Scripts/python benchmarks/run_p2.py llama3.2:3b

Writes benchmarks/p2_baseline.json and benchmarks/p2_baseline.md.
"""

from __future__ import annotations

import asyncio
import json
import statistics
import sys
import time
from pathlib import Path
from typing import Literal

import httpx
import yaml
from pydantic import BaseModel, ConfigDict, Field

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from app.agent_runtime.heal import generate_typed  # noqa: E402
from app.models.base import Message  # noqa: E402
from app.models.ollama import OllamaClient  # noqa: E402
from pos_schemas import ModelProfile, Plan  # noqa: E402

OLLAMA = "http://127.0.0.1:11434"


class _S(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Extraction(_S):
    person: str = Field(min_length=1)
    organization: str = Field(min_length=1)
    year: int = Field(ge=1000, le=2100)


class Classification(_S):
    label: Literal["positive", "negative", "neutral"]
    confidence: float = Field(ge=0, le=1)


class Category(_S):
    category: Literal["bug", "feature", "question", "docs"]
    urgent: bool


class FactAnswer(_S):
    answer: str = Field(min_length=1, max_length=300)
    needs_web_verification: bool
    reason: str = Field(max_length=300)


SCHEMAS: dict[str, type[BaseModel]] = {
    "extraction": Extraction,
    "classification": Classification,
    "category": Category,
    "planning": Plan,
    "current_fact": FactAnswer,
}

SYSTEM = {
    "extraction": "Extract the person, the organization and the year from the text. Reply with JSON only.",
    "classification": "Classify the sentiment of the text as positive, negative or neutral with a confidence. JSON only.",
    "category": "Triage the issue: category bug|feature|question|docs and whether it is urgent. JSON only.",
    "planning": "You are an orchestrator. Agents: research, writer, validator. Give a web search query and one "
    "step per agent in order research, writer, validator. JSON only.",
    "current_fact": "Answer briefly. Set needs_web_verification=true when the answer can change over time and must "
    "be checked against current sources. JSON only.",
}


def models_from_manifests() -> list[str]:
    seen: list[str] = []
    for m in sorted((ROOT / "agents").glob("*/manifest.yaml")):
        model = yaml.safe_load(m.read_text())["model_profile"]["model"]
        if model not in seen:
            seen.append(model)
    return seen


async def unload(model: str) -> None:
    async with httpx.AsyncClient(timeout=30) as http:
        await http.post(f"{OLLAMA}/api/generate", json={"model": model, "keep_alive": 0})


async def bench_model(client: OllamaClient, model: str, prompts: list[dict]) -> dict:
    rows = []
    profile = ModelProfile(model=model, temperature=0, max_tokens=256)
    for p in prompts:
        cls = SCHEMAS[p["kind"]]
        schema = cls.model_json_schema()
        if cls is Plan:
            schema["$defs"]["PlanStep"]["properties"]["agent_id"]["enum"] = [
                "research",
                "writer",
                "validator",
            ]
        msgs = [Message("system", SYSTEM[p["kind"]]), Message("user", p["prompt"])]
        t0 = time.perf_counter()
        try:
            h = await generate_typed(client, profile, msgs, cls, lambda: None, schema=schema)  # type: ignore[arg-type,return-value]
            err = None
        except Exception as e:  # count provider errors, do not crash the run
            h, err = None, f"{type(e).__name__}: {e}"
        m0 = h.metrics[0] if h and h.metrics else None
        rows.append(
            {
                "id": p["id"],
                "kind": p["kind"],
                "first_try_valid": bool(h and h.attempts == 1 and not h.fell_back),
                "valid_after_heal": bool(h and not h.fell_back),
                "retries": (h.attempts - 1) if h else None,
                "ttft_ms": m0.ttft_ms if m0 else None,
                "tok_s": m0.tok_s if m0 else None,
                "total_ms": round((time.perf_counter() - t0) * 1000),
                "completion_tokens": sum(m.completion_tokens for m in h.metrics) if h else None,
                "error": err,
                "first_error": (h.errors[0][0]["msg"] if h and h.errors else None),
            }
        )
        r = rows[-1]
        print(
            f"  {model:14s} {p['id']:>3} {p['kind']:15s} valid1={r['first_try_valid']!s:5} healed={r['valid_after_heal']!s:5} "
            f"ttft={r['ttft_ms']}ms tok/s={r['tok_s']} total={r['total_ms']}ms {r['error'] or ''}",
            flush=True,
        )
    ok = [r for r in rows if r["error"] is None]
    warm = ok[1:] or ok  # first call includes model load; report it separately
    med = lambda k, xs: round(statistics.median([r[k] for r in xs]), 1) if xs else None  # noqa: E731
    return {
        "model": model,
        "n": len(rows),
        "schema_accuracy_first_try": round(sum(r["first_try_valid"] for r in rows) / len(rows), 4),
        "schema_accuracy_after_heal": round(
            sum(r["valid_after_heal"] for r in rows) / len(rows), 4
        ),
        "retries_total": sum(r["retries"] or 0 for r in rows),
        "errors": sum(r["error"] is not None for r in rows),
        "cold_ttft_ms": rows[0]["ttft_ms"],
        "median_ttft_ms_warm": med("ttft_ms", warm),
        "median_tok_s_warm": med("tok_s", warm),
        "median_total_ms_warm": med("total_ms", warm),
        "p95_total_ms_warm": round(
            sorted(r["total_ms"] for r in warm)[max(0, int(len(warm) * 0.95) - 1)]
        )
        if warm
        else None,
        "rows": rows,
    }


def markdown(results: list[dict], meta: dict) -> str:
    out = [
        "# P2 baseline — Ollama structured output (T=0)",
        "",
        f"{meta['when']} · {meta['n_prompts']} prompts/model · format = JSON Schema (grammar-constrained) · one healing retry",
        "",
        "| model | schema ✓ 1st try | ✓ after heal | retries | cold TTFT | median TTFT (warm) | median tok/s | median total | p95 total | errors |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for r in results:
        out.append(
            f"| {r['model']} | {r['schema_accuracy_first_try']:.1%} | {r['schema_accuracy_after_heal']:.1%} | {r['retries_total']} | "
            f"{r['cold_ttft_ms']} ms | {r['median_ttft_ms_warm']} ms | {r['median_tok_s_warm']} | {r['median_total_ms_warm']} ms | "
            f"{r['p95_total_ms_warm']} ms | {r['errors']} |"
        )
    out += ["", "By kind (first-try valid / n):", ""]
    kinds = sorted({row["kind"] for r in results for row in r["rows"]})
    out.append("| model | " + " | ".join(kinds) + " |")
    out.append("|---|" + "---|" * len(kinds))
    for r in results:
        cells = []
        for k in kinds:
            ks = [x for x in r["rows"] if x["kind"] == k]
            cells.append(f"{sum(x['first_try_valid'] for x in ks)}/{len(ks)}")
        out.append(f"| {r['model']} | " + " | ".join(cells) + " |")
    return "\n".join(out) + "\n"


async def main() -> None:
    prompts = json.loads((ROOT / "benchmarks" / "prompts_p2.json").read_text(encoding="utf-8"))
    assert len(prompts) == 30, len(prompts)
    models = sys.argv[1:] or models_from_manifests()
    client = OllamaClient(OLLAMA, timeout_s=300)
    have = await client.list_models()
    missing = [m for m in models if m not in have and f"{m}:latest" not in have]
    if missing:
        print("Missing models. Run:\n" + "\n".join(f"  ollama pull {m}" for m in missing))
        models = [m for m in models if m not in missing]
    results = []
    for model in models:
        print(f"== {model}", flush=True)
        results.append(await bench_model(client, model, prompts))
        await unload(model)  # keep RAM free for the next model
    meta = {
        "when": time.strftime("%Y-%m-%d %H:%M:%S"),
        "n_prompts": len(prompts),
        "ollama": OLLAMA,
        "temperature": 0,
    }
    (ROOT / "benchmarks" / "p2_baseline.json").write_text(
        json.dumps({"meta": meta, "results": results}, indent=1), encoding="utf-8"
    )
    md = markdown(results, meta)
    (ROOT / "benchmarks" / "p2_baseline.md").write_text(md, encoding="utf-8")
    print("\n" + md)


if __name__ == "__main__":
    asyncio.run(main())
