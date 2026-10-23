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
          -> if objective rises by >= 0.3: same-scale check against the setup
             act/venue ranking (no extra call)
          -> accept or reject in code                                       [decision]
          -> accepted: qloo_compare_audiences, previous vs. new bill (taste evidence)
stop      planner stops | no untried legal move | 3 (heuristic) / 4 (any) rejections in a row
          | budget minus 1 reserved call | 10 iterations
final     qloo_recommend (brands, explain) for the best lineup; draft-vs-final taste compare if not already run
```

Acceptance rule (`search.ts`): a move is accepted only if

1. the new lineup has an `ok` `qloo_rank` result containing at least one target brand, and
2. its objective beats the current one by at least 0.3 points, and
3. if the lineup's fit part rose, the **same-scale check** agrees: in the one setup `qloo_rank` call that scored every candidate act (option_type artist) or venue (option_type place) against the target brands together, the incoming act or venue is not more than 0.02 below the one it replaces. A move that wins on cohesion or momentum alone needs no fit confirmation. If the venue was never scored, the per-lineup `qloo_rank` decides and the trace says so.

### Why a same-scale check, not a head-to-head compare

Qloo's harness says `qloo_rank` scores from separate calls are not directly comparable, and each lineup is scored in its own call. The first design confirmed gains with `qloo_compare_audiences` (`target_type: brand`). The Oct 22 live probe showed that compare returns shared and per-side **tags** (`results = {tags, a, b, matchEntities}`) with no per-side brand numbers, and `target_type: brand` adds no brand rows. So a brand-fit comparison has to come from `qloo_rank`. Ranking the lineups themselves in one call is impossible (a lineup is not an entity), and ranking the target brands against the union of both lineups would score a blend. The comparable signal Qloo does offer is one call that ranks all candidate acts (or venues) against the brands; a swap changes exactly one act, so comparing the outgoing and incoming act on that shared scale confirms or refutes the direction of the gain at no extra cost.

`qloo_compare_audiences` is still called once per accepted move (and draft vs. final) as taste evidence: shared tastes with Qloo's similarity score (`tags[].query.score`), plus tags only one side has (`a[]`/`b[]` with `query.count`). It is shown in the trace and evidence cards and never decides a move.

Evaluations are cached by lineup (act set + slot), and the planner never re-proposes a tested lineup. Legal moves respect each act's unavailable dates.

## Planners

- **Nemotron** (`NVIDIA_API_KEY` set): gets a JSON state (goal, target brands, the current bill and bench with per-act Qloo evidence, slots, recent history, the top 5 moves by prior, calls left) and must answer with JSON: swap, slot, or stop. The reply is validated against the legal-move list. Anything unusable (not JSON, unknown act, illegal or repeated move, a stop before any move was tested) falls back to the heuristic, with a note in the trace. Its one-sentence rationale is shown only if it contains no digits, so the model cannot put numbers on screen. Temperature 0.2, thinking disabled.
- **Heuristic**: ranks legal moves by a prior computed from setup evidence only (act-level brand affinity from the shared `qloo_rank` call, venue affinity, exact cohesion and momentum deltas), proposes the best, and stops after 3 rejections in a row or when nothing looks within 2 points of the current prior.

## Scoring

All in `scoring.ts`, unit-tested:

- **Fit** = weighted mean of target-brand affinities from the lineup's `qloo_rank` call; the primary (first) brand counts double.
- **Cohesion** = mean pairwise weighted Jaccard overlap of the acts' `qloo_entity_tags` profiles (sum of mins over sum of maxes across the union of tags).
- **Momentum** = per act, relative change between the mean of the first and last thirds of the `qloo_trends` series sorted by date (population_percentile; population_rank flipped as a fallback), clamped to [-1, 1]; the lineup's mean is mapped to [0, 1]. When any candidate act has trend data, acts without it count as 0 (flat).
- **Objective** = goal-weighted blend of the parts present, x 100.
- **Sponsor side**: event score = 75% mean act affinity + 25% venue affinity for the brand's audience; index = score / mean score of the pasted list x 100. More than 10 acts are ranked in several calls that share an anchor act; later calls are rescaled by the anchor's affinity ratio.

## Pass-through layouts (confirmed in the Oct 22 live probe)

The harness passes Qloo's raw results through for two tools, so `parse.ts` reads them directly and reports "layout not recognized" with the keys it saw instead of guessing:

- `qloo_compare_audiences`: `results = {tags: [...], a: [...], b: [...], matchEntities: []}`. `tags[i]` = `{tag_id, name, type: "urn:tag", subtype, entity_id, popularity, query: {score, "a.signal.interests.entities", "b.signal.interests.entities"}}`; `a[i]`/`b[i]` = each side's own tags with `query.count`. Bare names in the groups return `needs_input` (artist vs. person), so only IDs are sent.
- `qloo_trends`: `series = [{entity: {input, entityId, name, type, match}, points: [...]}]`, weekly, newest first, capped by `limit`. Point keys: `date`, `population_percentile` (0..1), `population_rank` (a string), `population_rank_velocity`, `velocity_fold_change`, `population_percent_delta`. A window ending today returned `points: []`; windows ending months back returned data. SponsorMatch asks for 20 weekly points in a 20-week window ending 120 days before today, computes momentum from the population_percentile change (rank as fallback), shows "no recent trend data" for empty series, and counts those acts as flat so missing data never blocks or helps a move.

Fixtures `compare-audiences.json`, `trends.json` and `rank-artists-ok.json` reproduce these layouts with synthetic values.

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

- Qloo has no date-level affinity. Dates are availability constraints; momentum uses a 20-week window ending about four months before today, because recent trend data is not available yet.
- `qloo_rank` scores from separate calls are query-relative. The same-scale check addresses this for accepted fit gains; rejected moves rely on per-lineup `qloo_rank` alone. The same-scale act ranking uses the draft venue's city as `signal_location`.
- `qloo_compare_audiences` gives taste overlap, not brand fit, so it explains moves without scoring them.
