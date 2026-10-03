# P3 model matrix (G3.12)

2026-10-03 16:43:59 | 8 prompts/model (planner 8) | T=0 | production prompts + schemas + one healing retry | free RAM at start 7.4 GiB

Rubric (deterministic): 1 invalid after heal | 2 valid, wrong | 3 partly right | 4 right after heal or minor miss | 5 right first try

| model | VRAM GiB | GPU share | schema 1st try | schema after heal | mean score | planner | research | writer | reasoning | cold TTFT | median TTFT | median tok/s | median total |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| phi3.5 | 2.19 | 0.6 | 62% | 62% | 2.5 | 2.5 | None | None | None | 6041 ms | 580 ms | 17.0 | 21321 ms |
| mistral:7b | 2.16 | 0.46 | 88% | 88% | 4.5 | 4.5 | None | None | None | 9623 ms | 610 ms | 7.4 | 36621 ms |

## Recommendation per role

| role | model | score | best score |
|---|---|---|---|
| planner | mistral:7b | 4.5 | 4.5 |

## Misses (score < 5)

- **phi3.5**: p01=3 (branches=2/1 terms=ok shape=ok); p02=1 (invalid); p03=3 (branches=2/1 terms=ok shape=ok); p04=1 (invalid); p05=3 (branches=3/1 terms=ok shape=ok); p06=1 (invalid); p08=3 (branches=3/1 terms=ok shape=ok)
- **mistral:7b**: p04=1 (invalid)
