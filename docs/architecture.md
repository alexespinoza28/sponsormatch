# Architecture and agent internals

## Layout

```
src/app/page.tsx                 single page; passes only mode flags to the client
src/app/api/optimize/route.ts    lineup optimizer, streams trace events as NDJSON
src/app/api/sponsor/route.ts     sponsor-side event ranking, NDJSON
src/app/api/health/route.ts      health check (harness readiness via qloo_capabilities)
src/components/                  producer and sponsor views, trace, score chart, budget meter, evidence cards
src/lib/optimizer/search.ts      the agent loop (setup, propose, measure, decide, stop, final)
src/lib/optimizer/proposer.ts    Nemotron planner + heuristic planner, legal-move generation
src/lib/optimizer/qloo-steps.ts  Qloo evidence steps (describe, rank with needs_input repair and anchoring, tags, trends, compare)
src/lib/optimizer/scoring.ts     pure scoring math (fit, cohesion, momentum, objective)
src/lib/optimizer/parse.ts       readers for compare_audiences and trends layouts
src/lib/optimizer/budget.ts      hard call budget, call log, envelope classification
src/lib/optimizer/sponsor.ts     sponsor-side ranking
src/lib/qloo/mcp.ts              qloo mcp process manager and MCP tool client
src/lib/qloo/mock.ts             offline mock returning harness-shaped envelopes
src/lib/llm/nemotron.ts          NVIDIA chat-completions client
tests/                           Vitest suites and synthetic envelope fixtures
```

## How Qloo is called

`src/lib/qloo/mcp.ts` spawns `node node_modules/@qloo/qloo-harness/dist/bin.js mcp` with the official MCP SDK stdio client, once per server process (started on first use, restarted if it exits). The harness gets only `QLOO_*` variables plus a few system ones; `NVIDIA_API_KEY` is not forwarded. Defaults: `QLOO_BASE_URL` and `QLOO_TRUSTED_BASE_URL` = `https://hackathon.api.qloo.com`, `QLOO_HOME` = a temp dir (never `~/.qloo/config`).

Envelope handling:

- `ok`: use the results. `partial` / `degraded`: use them and show the summary as a warning.
- `empty`: recorded; for a lineup score it means "no evidence", so the move is rejected.
- `needs_input`: show the candidates, continue with the first (for venues, the candidate whose address matches the city), and let the user click another to re-run with that exact entity (a "pin").
- `error`: retried once only when `error.retryable`. A non-retryable `QLOO_AUTH` stops the run and blocks Qloo calls from that server for five minutes.

Entities are resolved once and passed as IDs afterward. In the live API a bare act name in `signals` comes back as `needs_input` when it matches both an artist and a person, so the agent never puts names into signals: acts and venues are resolved through `qloo_rank` with a typed `option_type` (one call for all of them), brands through `qloo_describe` with `type: brand`.

## The loop

```
setup     describe brands -> rank acts (artist) -> rank venues (place)
          -> entity_tags per act -> trends (5 acts per call) -> rank brands for the draft
loop      planner proposes one move
          -> qloo_rank (brands) for the new lineup                         [evidence]
          -> if objective rises by >= 0.3: qloo_compare_audiences, current vs. new
          -> accept or reject in code                                       [decision]
stop      planner stops | no untried legal move | 3 (heuristic) / 4 (any) rejections in a row
          | budget minus 1 reserved call | 10 iterations
final     qloo_recommend (brands, explain) for the best lineup; draft-vs-final compare if not already run
```

Acceptance rule (`search.ts`): a move is accepted only if

1. the new lineup has an `ok` `qloo_rank` result containing at least one target brand, and
2. its objective beats the current one by at least 0.3 points, and
3. a parsed head-to-head does not show the target brands leaning toward the current lineup (mean `b - a` below -0.01).

If the compare layout cannot be read, or the budget leaves no room for it, the move is accepted on `qloo_rank` alone and the trace says so.

Evaluations are cached by lineup (act set + slot), and the planner never re-proposes a tested lineup. Legal moves respect each act's unavailable dates.

## Planners

- **Nemotron** (`NVIDIA_API_KEY` set): gets a JSON state (goal, target brands, the current bill and bench with per-act Qloo evidence, slots, recent history, the top 5 moves by prior, calls left) and must answer with JSON: swap, slot, or stop. The reply is validated against the legal-move list. Anything unusable (not JSON, unknown act, illegal or repeated move, a stop before any move was tested) falls back to the heuristic, with a note in the trace. Its one-sentence rationale is shown only if it contains no digits, so the model cannot put numbers on screen. Temperature 0.2, thinking disabled.
- **Heuristic**: ranks legal moves by a prior computed from setup evidence only (act-level brand affinity from the shared `qloo_rank` call, venue affinity, exact cohesion and momentum deltas), proposes the best, and stops after 3 rejections in a row or when nothing looks within 2 points of the current prior.

## Scoring

All in `scoring.ts`, unit-tested:

- **Fit** = weighted mean of target-brand affinities from the lineup's `qloo_rank` call; the primary (first) brand counts double.
- **Cohesion** = mean pairwise weighted Jaccard overlap of the acts' `qloo_entity_tags` profiles (sum of mins over sum of maxes across the union of tags).
- **Momentum** = per act, relative change between the mean of the first and last thirds of the `qloo_trends` series (rank fields flipped so up is good), clamped to [-1, 1]; the lineup's mean is mapped to [0, 1].
- **Objective** = goal-weighted blend of the parts present, x 100.
- **Sponsor side**: event score = 75% mean act affinity + 25% venue affinity for the brand's audience; index = score / mean score of the pasted list x 100. More than 10 acts are ranked in several calls that share an anchor act; later calls are rescaled by the anchor's affinity ratio.

## Unverified layouts

`qloo_compare_audiences` passes Qloo's `/v2/analysis/compare` `results` through unchanged, and `qloo_trends` passes raw `/v2/trending` points; neither layout is fixed by the harness. `parse.ts` accepts several plausible layouts (`query.a.affinity` / `query.b.affinity`, `affinity_a` / `affinity_b`, a `delta` field; `population_percentile`, `population_rank`, `popularity` for trends) and reports "layout not recognized" with the keys it saw instead of guessing. Check both against the live API; the fixtures `compare-brands.json` and `trends.json` are assumptions.

## Mock mode

With `QLOO_API_KEY` unset the app never starts the harness. `src/lib/qloo/mock.ts` returns harness-shaped envelopes built from synthetic fixtures (`src/lib/qloo/fixtures/catalog.json`: fictional brands, invented tags). Every entity gets a deterministic synthetic taste vector, and affinity, tags, compare rows, explainability and trends all derive from those vectors, so a swap changes every score consistently. The mock mirrors the confirmed live behavior: `qloo_capabilities` ready with 9 operations; an untyped name in `signals` returns `needs_input` with an artist and a person candidate; brand results carry entity_id, name, type, subtype, popularity, affinity, explainability, properties.

## Environment variables

Read only by server code; never sent to the browser.

| Variable | Secret | Purpose |
| --- | --- | --- |
| `QLOO_API_KEY` | yes | Qloo hackathon key, passed to the local `qloo mcp` process. Unset = mock mode. |
| `NVIDIA_API_KEY` | yes | Nemotron planner. Unset = heuristic planner. |
| `NVIDIA_MODEL` | no | Default `nvidia/nemotron-3.5-lightning-30b-a3b`. |
| `QLOO_BASE_URL`, `QLOO_TRUSTED_BASE_URL` | no | Default `https://hackathon.api.qloo.com` (hackathon keys fail on the harness default). |
| `QLOO_HOME` | no | Harness state dir. Default `<tmp>/sponsormatch-qloo-home`. |

## Safeguards and limits

- Keys stay on the server; the page gets only "live"/"mock" and the public model name.
- Only public names (acts, venues, cities, brands) are sent to Qloo. No personal data.
- Hard budget: 12-60 Qloo tool calls per optimizer run (validated against the setup cost), 12 per sponsor run. Calls past the cap are refused locally and never reach the harness.
- Inputs: up to 10 acts, 4 venue/date options, 3 target brands, bill of 2-4; up to 8 events of up to 4 acts on the sponsor side.
- `?autorun=1` runs the sample only in mock mode, so a shared link cannot spend Qloo quota.

## Known limitations

- Qloo has no date-level affinity. Dates are availability constraints; momentum uses the 90 days before today.
- `qloo_rank` scores from separate calls are query-relative. The head-to-head check addresses this for accepted moves; rejected moves rely on `qloo_rank` alone.
- The compare and trends layouts above are unverified until the live test.
