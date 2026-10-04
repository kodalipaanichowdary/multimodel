"""Q.1 failure taxonomy from recorded diagnostics only (deterministic, no model).

    apps/api/.venv/Scripts/python benchmarks/taxonomy.py answerability_baseline1 answerability_baseline2

Every non-correct answerable run gets all causes visible in its diagnostics ('any') and one
PRIMARY cause (first match in PRIMARY_ORDER). p3_soak.json has no per-run diagnostics, so its
unverified runs are listed by prompt only. Writes benchmarks/q_taxonomy.md.
"""

from __future__ import annotations

import json
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MULTI = re.compile(r"\b(compare|versus|vs\.?|difference between)\b|\bwhich\b[^?]*\bor\b", re.I)
MISSING = re.compile(r"not stated together there: \[([^\]]*)\]")
WRITER_CAPPED = re.compile(r"^writer#\d .* 400tok$")
PRIMARY_ORDER = [
    "fetch failure",
    "writer hallucination",
    "truncation (token cap)",
    "answer format (bare / uncited)",
    "multi-item bundling",
    "possessive/term mismatch",
    "number/unit format",
    "passage miss",
    "contradiction flag",
    "planner over-branch",
    "other",
]


def tags(r: dict, single: bool) -> list[str]:
    d = r["diag"]
    out = []
    fetches = len(d.get("fetch_urls", []))
    fetch_fails = sum(1 for t in d.get("tool_failed", []) if t.startswith("fetch_url"))
    val = " ".join(d.get("validator", []))
    missing = " ".join(MISSING.findall(val))
    capped = any(WRITER_CAPPED.search(c) for c in d.get("model_calls", []))
    if r["status"] == "no_sources" or (fetches and fetch_fails >= fetches):
        out.append("fetch failure")
    if r["score"] == "wrong":
        out.append("writer hallucination")
    if capped or "EOF while parsing" in json.dumps(d):
        out.append("truncation (token cap)")
    if "truncated" in val or "has no [n] citation" in val or "no substantive claim" in val:
        out.append("answer format (bare / uncited)")
    if r["cat"] == "compare" and re.search(r"cited source\(s\) \[\d+, \d+", val):
        out.append("multi-item bundling")
    if re.search(r"\w['\u2019]s\b", missing):
        out.append("possessive/term mismatch")
    if re.search(r"'\d", missing):
        out.append("number/unit format")
    if missing and not re.search(r"'\d", missing):
        out.append("passage miss")
    if "sources disagree" in val:
        out.append("contradiction flag")
    if single and d.get("research_branches", 0) > 1:
        out.append("planner over-branch")
    return out or ["other"]


def main(labels: list[str]) -> None:
    spec = json.loads((ROOT / "benchmarks" / "answerability.json").read_text(encoding="utf-8"))
    prompts = {q["id"]: q["prompt"] for q in spec["questions"]}
    primary: Counter[str] = Counter()
    anytag: Counter[str] = Counter()
    examples: dict[str, list[str]] = {}
    n_fail = 0
    for label in labels:
        d = json.loads((ROOT / "benchmarks" / f"{label}.json").read_text(encoding="utf-8"))
        short = label.replace("answerability_", "")
        for r in d["runs"]:
            if r["score"] in ("correct", "full") or r["cat"] == "unanswerable":
                continue
            n_fail += 1
            single = r["cat"] != "compare" and not MULTI.search(prompts[r["id"]])
            t = tags(r, single)
            anytag.update(set(t))
            p = next(c for c in PRIMARY_ORDER if c in t)
            primary[p] += 1
            examples.setdefault(p, []).append(f"{short}:{r['id']}#{r['rep']}")
    lines = [
        "# Q.1 failure taxonomy",
        "",
        f"Sources: {', '.join(labels)} (non-holdout, live). Non-correct answerable runs: {n_fail}.",
        "Primary = first matching cause in table order; any = runs showing the cause at all.",
        "",
        "| cause | primary | any | examples (primary) |",
        "|---|---|---|---|",
    ]
    for c in PRIMARY_ORDER:
        ex = ", ".join(examples.get(c, [])[:5])
        lines.append(f"| {c} | {primary[c]} | {anytag[c]} | {ex} |")
    att, why = 0, Counter()
    for label in labels:
        d = json.loads((ROOT / "benchmarks" / f"{label}.json").read_text(encoding="utf-8"))
        for r in d["runs"]:
            att += len(r["diag"]["fetch_urls"])
            for t in r["diag"]["tool_failed"]:
                if t.startswith("fetch_url"):
                    why[re.sub(r"https?://\S+", "URL", t.split("fetch_url: ")[-1])[:60]] += 1
    lines += [
        "",
        f"Fetch: {sum(why.values())} of {att} fetch attempts failed "
        f"({100 * sum(why.values()) / max(1, att):.0f}%); reasons:",
        "",
    ]
    lines += [f"- {v}x {k}" for k, v in why.most_common(6)]
    soak = json.loads((ROOT / "benchmarks" / "p3_soak.json").read_text(encoding="utf-8"))
    by_prompt = Counter(r["prompt"][:70] for r in soak["runs_detail"] if r["honest_unverified"])
    lines += ["", "## p3_soak.json unverified runs (no per-run diagnostics recorded)", ""]
    lines += [f"- {v}x {k}" for k, v in by_prompt.most_common()]
    out = ROOT / "benchmarks" / "q_taxonomy.md"
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main(sys.argv[1:] or ["answerability_baseline1", "answerability_baseline2"])
