# P3 model matrix (G3.12)

2026-10-03 16:33:20 | 8 prompts/model (planner 8) | T=0 | production prompts + schemas + one healing retry | free RAM at start 7.4 GiB

Rubric (deterministic): 1 invalid after heal | 2 valid, wrong | 3 partly right | 4 right after heal or minor miss | 5 right first try

| model | VRAM GiB | GPU share | schema 1st try | schema after heal | mean score | planner | research | writer | reasoning | cold TTFT | median TTFT | median tok/s | median total |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| llama3.2:3b | 2.17 | 0.8 | 88% | 88% | 3.5 | 3.5 | None | None | None | 7347 ms | 145 ms | 46.7 | 4994 ms |

## Recommendation per role

| role | model | score | best score |
|---|---|---|---|
| planner | llama3.2:3b | 3.5 | 3.5 |

## Misses (score < 5)

- **llama3.2:3b**: p01=3 (branches=3/1 terms=ok shape=ok); p03=3 (branches=3/1 terms=ok shape=ok); p04=1 (invalid); p07=3 (branches=3/2 terms=ok shape=ok); p08=3 (branches=3/1 terms=ok shape=ok)
