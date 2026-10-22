# SponsorMatch

An agent for local event producers. Give it a lineup, a venue and a city, and it uses Qloo's taste graph to find the brands that audience already has affinity for, shows the evidence for each match, and drafts a sponsor pitch per brand built only from that evidence.

Built for the [Qloo Agentic Hackathon](https://qloo.devpost.com/). All Qloo access goes through Qloo's official harness, [`@qloo/qloo-harness`](https://github.com/qloo/qloo-hackathon-kit), running as a local MCP server (`qloo mcp`).

## What it does

Small and mid-size promoters pitch sponsors on gut feel ("our crowd probably likes craft beer"). SponsorMatch replaces the guess with Qloo affinity data and turns it into a pitch the producer can send:

1. **Resolve.** `qloo_describe` matches each performer, the venue and the city to Qloo entities; `qloo_find_tags` turns an optional sponsor category into a Qloo brand-genre tag. When the harness answers `needs_input`, the page shows the candidates; the agent continues with the first one, and clicking another re-runs with that exact entity.
2. **Profile.** `qloo_audience_demographics` (per performer) and `qloo_entity_tags` (for the whole lineup) describe who this audience is: age and gender affinity, and the taste tags it over-indexes on.
3. **Rank.** `qloo_recommend` with `target_type: "brand"`, the performers and venue as `signals`, the city as `signal_location`, and explainability on. If the producer lists brands they already have in mind, `qloo_rank` scores those too. Empty results relax the query (drop the category, then the location) and say so.
4. **Explain.** For each top brand, `qloo_entity_tags` and `qloo_audience_demographics` give the brand's own tags and audience; `qloo_where_popular` finds where in the city the brand's affinity is strongest. The agent computes shared tags and demographic alignment and re-ranks by a transparent sponsor-fit score.
5. **Draft.** NVIDIA Nemotron writes one paragraph per brand using only the evidence from steps 2 to 4. A guard rejects drafts that cite numbers not in the evidence and falls back to a deterministic template.

Each step streams to the page as it runs, with the agent's decisions, any `partial`/`degraded` warnings from the harness, and every MCP tool call with its status and the Qloo API requests the harness reports in its provenance (never the key).

## Why it is Qloo-powered

Without Qloo there is nothing to rank or explain. Every number on a brand card comes from a Qloo workflow:

| Step | MCP tool (qloo mcp) | Used for |
| --- | --- | --- |
| Resolve | `qloo_describe` (`type`: artist, place, locality) | Entity IDs for performers, venue and city, with candidates when ambiguous |
| Resolve | `qloo_find_tags` | Optional sponsor category as a `urn:tag:genre:brand:*` tag |
| Profile | `qloo_audience_demographics` | Audience age and gender affinity |
| Profile | `qloo_entity_tags` | Taste tags the lineup's audience over-indexes on |
| Rank | `qloo_recommend` (`target_type: brand`, `signals`, `signal_location`, `include_tags`, `explain`) | Brand affinity scores and per-signal contributions |
| Rank | `qloo_rank` (`option_type: brand`) | Scores for brands the producer already has in mind |
| Explain | `qloo_entity_tags`, `qloo_audience_demographics` on each brand | Shared tags; brand audience vs. event audience |
| Explain | `qloo_where_popular` (`within`: the city) | Local hotspots for street-level promotion |

The less obvious parts: comparing the demographic affinity of the event audience with each brand's own audience (cosine similarity across Qloo's age buckets and gender), using `qloo_where_popular` to turn a national brand into a local activation, and using explainability to tell a sponsor which act on the bill drives the match.

**Sponsor fit** (0 to 100) = 60% Qloo affinity + 25% audience tag overlap + 15% demographic alignment. Tag overlap is the mean audience affinity across the brand's top Qloo tags. If a component is missing, the remaining weights are renormalized. The raw Qloo rank is always shown next to the re-ranked position.

Qloo affinity scores describe aggregate taste associations. SponsorMatch presents them that way and never as predictions about individual attendees or sales.

## Run it locally

Requires Node.js 22.19 or newer (developed on Node 24). The harness is a pinned dependency; nothing is installed globally.

```sh
npm install
cp .env.example .env   # optional; leave values empty for mock mode
npm run dev            # http://localhost:3000
npm run smoke:mcp      # starts node_modules' qloo mcp, lists tools, calls qloo_capabilities (no Qloo request)
```

### How Qloo is called

`src/lib/qloo/mcp.ts` spawns `node node_modules/@qloo/qloo-harness/dist/bin.js mcp` with the official MCP SDK stdio client, once per server process (started on first use, restarted if it exits). It passes the harness only `QLOO_*` variables plus a few system ones. Every tool returns the harness's result envelope; the agent handles each status:

- `ok`: use the results.
- `partial` / `degraded`: use the results and show the harness's summary as a warning.
- `empty`: record it and relax the query where that makes sense.
- `needs_input`: show the candidates; continue with the first and let the user pick another.
- `error`: retry once only when `error.retryable` is true. A non-retryable `QLOO_AUTH` stops the run and blocks Qloo calls from that server for five minutes. Other errors are reported in the step and skipped.

### Mock mode

With `QLOO_API_KEY` unset, the app never starts the harness. A mock returns the same envelopes from synthetic fixtures (`src/lib/qloo/fixtures/catalog.json`): fictional brands, invented IDs and scores, labeled as mock data in the UI. Try the performer "Phoenix" to see the `needs_input` flow. With `NVIDIA_API_KEY` unset, pitches come from a deterministic template.

### Environment variables

Read only by server code; never sent to the browser.

| Variable | Secret | Purpose |
| --- | --- | --- |
| `QLOO_API_KEY` | yes | Qloo hackathon key, passed to the local `qloo mcp` process. Unset = mock mode. |
| `NVIDIA_API_KEY` | yes | NVIDIA API key for Nemotron pitch drafts. Unset = template pitches. |
| `NVIDIA_MODEL` | no | Model override. Default `nvidia/nemotron-3.5-lightning-30b-a3b`. |
| `QLOO_BASE_URL` | no | Qloo API host for the harness. Default `https://hackathon.api.qloo.com` (hackathon keys do not work on the harness's own default, `api.qloo.com`). |
| `QLOO_TRUSTED_BASE_URL` | no | Must equal `QLOO_BASE_URL` for the harness to send the key to a non-default host. Defaults to the same value. |
| `QLOO_HOME` | no | Harness state directory. Default `<tmp>/sponsormatch-qloo-home`, so it never reads `~/.qloo/config`. |

## Tests and checks

```sh
npm test          # Vitest: MCP client (incl. a real qloo mcp spawn + qloo_capabilities), envelopes, mock, evidence, pitches, pipeline
npm run lint
npm run typecheck
npm run build
```

No test calls Qloo. The real-spawn test runs the harness without a key and calls only `qloo_capabilities`, which the harness answers locally.

## Deploy

The kit says `qloo mcp` must run on "a VM or container"; serverless functions are not a supported route. SponsorMatch therefore ships as a Docker image for a long-running Node host. `GET /api/health` reports readiness (in live mode it calls `qloo_capabilities`, which does not use Qloo quota).

### Render (Blueprint included)

1. Push the repo to GitHub.
2. In Render, choose **New > Blueprint** and select the repo. Render reads `render.yaml` (Docker web service, health check `/api/health`).
3. When prompted, paste `QLOO_API_KEY` and `NVIDIA_API_KEY`. The other variables are preset in `render.yaml`.
4. Deploy, then open `/api/health`: it should show `"ready": true`.

The free plan sleeps when idle, so the first request after a pause is slow. Use a paid instance for judging if that matters.

### Railway

1. **New Project > Deploy from GitHub repo**. Railway detects the `Dockerfile`.
2. In **Variables**, add `QLOO_API_KEY` and `NVIDIA_API_KEY`. Optionally add `NVIDIA_MODEL`, `QLOO_BASE_URL` and `QLOO_TRUSTED_BASE_URL` (both `https://hackathon.api.qloo.com`).
3. In **Settings > Networking**, generate a domain. Set the health check path to `/api/health`.

### Any Docker host

```sh
docker build -t sponsormatch .
docker run -p 3000:3000 -e QLOO_API_KEY -e NVIDIA_API_KEY sponsormatch
```

## Project layout

```
src/app/page.tsx                 single page (server component passes only mode flags to the client)
src/app/api/match/route.ts       agent endpoint, streams step events as NDJSON
src/app/api/health/route.ts      health check (harness readiness)
src/components/                  form, step timeline with MCP calls and choices, audience panel, brand cards
src/lib/qloo/mcp.ts              qloo mcp process manager and MCP tool client
src/lib/qloo/mock.ts             offline mock returning harness-shaped envelopes
src/lib/qloo/types.ts            tool input types (from the harness's tools/list) and the result envelope
src/lib/agent/                   pipeline (the five steps) and pure ranking/evidence logic
src/lib/llm/                     Nemotron client and evidence-only pitch drafting
scripts/mcp-smoke.mjs            manual smoke test for the local harness
tests/                           unit tests and synthetic envelope fixtures
Dockerfile, render.yaml          deployment
```

## Safeguards

- Keys stay on the server. The page receives only "live" or "mock" flags and the public model name. `NVIDIA_API_KEY` is not passed to the harness process.
- No personal data is sent to Qloo: only public performer, venue, city, category and brand names.
- Bounded work per run: at most 5 performers and 5 producer brands; about 20 to 25 MCP tool calls; 4 in parallel.

## Known limitations

- `qloo_audience_demographics` takes one entity per call, so demographics cost one call per performer and per brand.
- The harness's compact results do not include brand metadata such as use occasions, so the evidence uses tags, demographics, explainability and hotspots only.
- Explainability's exact JSON layout is not documented; the parser accepts the likely layouts and shows nothing if it differs.
- Hotspots are coordinates from Qloo's heatmap, not named neighborhoods.
- Pitch drafts are a starting point for the producer to edit, not a finished proposal.

## AI tools disclosure

This project was built with AI coding assistance. Claude Code (Anthropic) generated most of the code, tests and documentation under Alex Espinoza's direction. At runtime the app calls NVIDIA Nemotron to draft pitch text.

## License

[MIT](LICENSE)
