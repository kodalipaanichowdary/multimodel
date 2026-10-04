"""Before/after table across answerability runs (Q phase).

apps/api/.venv/Scripts/python benchmarks/q_table.py baseline1 baseline2 after-a ...
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ROWS = [
    ("golden correct", lambda m, c: m["golden_correct"]),
    ("simple correct", lambda m, c: _frac(c, "simple", ("correct",))),
    ("numeric correct %", lambda m, c: m["numeric_correct_pct"]),
    ("compare full+partial %", lambda m, c: m["compare_full_or_partial_pct"]),
    ("compare wrong", lambda m, c: m["compare_wrong"]),
    ("memory correct", lambda m, c: _frac(c, "memory", ("correct",))),
    ("unanswerable refused %", lambda m, c: m["unanswerable_refused_pct"]),
    ("wrong answers", lambda m, c: sum(v.get("wrong", 0) for v in c.values())),
    ("wrong rate %", lambda m, c: m["wrong_rate_pct"]),
    ("answerable unverified %", lambda m, c: m["answerable_unverified_pct"]),
]


def _frac(c: dict, cat: str, good: tuple[str, ...]) -> str:
    d = c.get(cat, {})
    return f"{sum(d.get(g, 0) for g in good)}/{d.get('n', 0)}"


def main(labels: list[str]) -> None:
    runs = [
        json.loads((ROOT / "benchmarks" / f"answerability_{x}.json").read_text(encoding="utf-8"))
        for x in labels
    ]
    print("| metric | " + " | ".join(labels) + " |")
    print("|---|" + "---|" * len(labels))
    for name, f in ROWS:
        print(
            f"| {name} | "
            + " | ".join(str(f(r["metrics"], r["per_category"])) for r in runs)
            + " |"
        )
    print("| total minutes | " + " | ".join(f"{r['total_seconds'] / 60:.0f}" for r in runs) + " |")


if __name__ == "__main__":
    main(sys.argv[1:])
