# Q.1 failure taxonomy

Sources: answerability_baseline1, answerability_baseline2 (non-holdout, live). Non-correct answerable runs: 42.
Primary = first matching cause in table order; any = runs showing the cause at all.

| cause | primary | any | examples (primary) |
|---|---|---|---|
| fetch failure | 0 | 0 |  |
| writer hallucination | 10 | 10 | baseline1:f01#2, baseline1:f01#5, baseline1:f01#7, baseline1:f01#8, baseline1:f01#9 |
| truncation (token cap) | 3 | 4 | baseline2:c02#1, baseline2:c04#1, baseline2:c06#1 |
| answer format (bare / uncited) | 22 | 33 | baseline1:f01#1, baseline1:f01#3, baseline1:f01#4, baseline1:f01#6, baseline1:f01#10 |
| multi-item bundling | 4 | 5 | baseline1:c01#1, baseline1:c03#1, baseline1:c06#1, baseline2:c01#1 |
| possessive/term mismatch | 1 | 2 | baseline1:c04#1 |
| number/unit format | 1 | 12 | baseline1:c02#1 |
| passage miss | 0 | 4 |  |
| contradiction flag | 0 | 1 |  |
| planner over-branch | 1 | 29 | baseline2:m03#1 |
| other | 0 | 0 |  |

Fetch: 101 of 604 fetch attempts failed (17%); reasons:

- 90x HTTP 403 for URL
- 3x unsupported content-type 'application/pdf'
- 3x [SSL: SSLV3_ALERT_HANDSHAKE_FAILURE] sslv3 alert handshake f
- 2x [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: 
- 2x page larger than 2000000 bytes
- 1x RuntimeError: Error executing tool fetch_url:

## p3_soak.json unverified runs (no per-run diagnostics recorded)

- 5x Compare the populations of Lyon, Marseille and Nice
- 5x Who wrote the novel Pride and Prejudice? Save the answer to a file
- 5x What is the boiling point of water at sea level in Celsius? Save the a
- 5x What did the Glorbnax Committee decide on 31 February 2031?
- 4x How tall is Mount Everest?
