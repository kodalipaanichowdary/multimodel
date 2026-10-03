# P3 model matrix (G3.12)

2026-10-03 16:32:14 | 36 prompts/model (planner 8, research 10, writer 10, reasoning 8) | T=0 | production prompts + schemas + one healing retry | free RAM at start 6.8 GiB

Rubric (deterministic): 1 invalid after heal | 2 valid, wrong | 3 partly right | 4 right after heal or minor miss | 5 right first try

| model | VRAM GiB | GPU share | schema 1st try | schema after heal | mean score | planner | research | writer | reasoning | cold TTFT | median TTFT | median tok/s | median total |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| llama3.2:3b | 2.17 | 0.8 | 94% | 94% | 3.92 | 2.75 | 5 | 3.5 | 4.25 | 6393 ms | 142 ms | 48.7 | 929 ms |
| phi3.5 | 2.19 | 0.6 | 100% | 100% | 4.47 | 3.75 | 5 | 4.4 | 4.62 | 5674 ms | 302 ms | 22.2 | 2201 ms |
| mistral:7b | 2.16 | 0.46 | 94% | 94% | 4.33 | 4 | 5 | 4.6 | 3.5 | 10034 ms | 679 ms | 7.9 | 6415 ms |

## Recommendation per role

| role | model | score | best score |
|---|---|---|---|
| planner | phi3.5 | 3.75 | 4 |
| research | llama3.2:3b | 5 | 5 |
| writer | phi3.5 | 4.4 | 4.6 |
| reasoning | phi3.5 | 4.62 | 4.62 |

## Misses (score < 5)

- **llama3.2:3b**: p01=3 (branches=3/1 terms=ok shape=ok); p02=3 (branches=4/3 terms=ok shape=ok); p03=3 (branches=3/1 terms=ok shape=ok); p04=1 (invalid); p06=1 (invalid); p07=3 (branches=3/2 terms=ok shape=ok); p08=3 (branches=3/1 terms=ok shape=ok); w01=4 (facts 1/1 validator=fail); w02=4 (facts 1/1 validator=fail); w03=4 (facts 1/1 validator=fail); w04=3 (facts 1/2 validator=pass); w05=4 (facts 2/2 validator=fail); w06=4 (facts 1/1 validator=fail); w07=3 (facts 1/2 validator=fail); w09=2 (answered an unanswerable question); w10=2 (facts 0/2 validator=fail); r01=2 (answer=175 golden=155); r08=2 (answer=35 golden=25)
- **phi3.5**: p01=3 (branches=2/1 terms=ok shape=ok); p03=3 (branches=4/1 terms=ok shape=ok); p04=3 (branches=4/2 terms=ok shape=ok); p05=3 (branches=3/1 terms=ok shape=ok); p08=3 (branches=4/1 terms=ok shape=ok); w01=4 (facts 1/1 validator=fail); w05=4 (facts 2/2 validator=fail); w09=2 (answered an unanswerable question); w10=4 (facts 2/2 validator=fail); r01=2 (answer=135 golden=155)
- **mistral:7b**: p03=1 (invalid); p04=1 (invalid); w05=4 (facts 2/2 validator=fail); w10=2 (facts 0/2 validator=fail); r03=2 (answer=10 golden=12); r06=2 (answer=189 golden=54); r07=2 (answer=32 golden=48); r08=2 (answer=30 golden=25)
