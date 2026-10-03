# P2 baseline — Ollama structured output (T=0)

2026-10-03 10:32:04 · 30 prompts/model · format = JSON Schema (grammar-constrained) · one healing retry

| model | schema ✓ 1st try | ✓ after heal | retries | cold TTFT | median TTFT (warm) | median tok/s | median total | p95 total | errors |
|---|---|---|---|---|---|---|---|---|---|
| llama3.2:3b | 100.0% | 100.0% | 0 | 8766 ms | 122 ms | 44.0 | 648 ms | 2881 ms | 0 |
| phi3.5 | 100.0% | 100.0% | 0 | 5384 ms | 392 ms | 18.6 | 2565 ms | 9174 ms | 0 |
| mistral:7b | 100.0% | 100.0% | 0 | 9650 ms | 541 ms | 7.6 | 5036 ms | 20840 ms | 0 |

By kind (first-try valid / n):

| model | category | classification | current_fact | extraction | planning |
|---|---|---|---|---|---|
| llama3.2:3b | 6/6 | 6/6 | 3/3 | 6/6 | 9/9 |
| phi3.5 | 6/6 | 6/6 | 3/3 | 6/6 | 9/9 |
| mistral:7b | 6/6 | 6/6 | 3/3 | 6/6 | 9/9 |
