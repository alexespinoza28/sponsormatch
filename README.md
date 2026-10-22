# SponsorMatch

An agent for local event producers. Give it a lineup, a venue and a city, and it uses Qloo's taste graph to find the brands that audience already has affinity for, shows the evidence for each match, and drafts a sponsor pitch per brand built only from that evidence.

Built for the [Qloo Agentic Hackathon](https://qloo.devpost.com/).

## What it does

Small and mid-size promoters pitch sponsors on gut feel ("our crowd probably likes craft beer"). SponsorMatch replaces the guess with Qloo affinity data and turns it into a pitch the producer can send:

1. **Resolve.** Matches each performer to a Qloo artist, the venue to a Qloo place, the city to a Qloo locality, and an optional sponsor category to a Qloo brand-genre tag. Ambiguous matches are shown with their alternatives.
2. **Profile.** Asks Qloo who this audience is: age and gender affinity for the lineup, and the brand-taste tags the lineup's fans over-index on in that city.
3. **Rank.** Asks Qloo which brands this audience has the highest affinity for, using the performers and venue as signals and the city as a location signal, with explainability turned on.
4. **Explain.** For the top brands it gathers more evidence: which tags the brand shares with the audience, which performer drives the affinity, how closely the brand's own audience demographics match the event's, and whether the brand has locations in the city. It then re-ranks by a transparent sponsor-fit score.
5. **Draft.** NVIDIA Nemotron writes one paragraph per brand using only the evidence from steps 2 to 4. A guard rejects drafts that cite numbers not in the evidence and falls back to a deterministic template.

Each step streams to the page as it runs, with the decisions the agent made and the exact Qloo requests behind them (never the key).

## Why it is Qloo-powered

Without Qloo there is nothing to rank or explain. Every number on a brand card comes from Qloo:

| Step | Qloo call | Used for |
| --- | --- | --- |
| Resolve | `GET /search` with `types=urn:entity:artist`, `urn:entity:place` (with `filter.address`), `urn:entity:locality` | Entity IDs for performers, venue and city |
| Resolve | `GET /v2/tags` with `filter.query` and `filter.parents.types=urn:entity:brand` | Optional sponsor category as a `urn:tag:genre:brand:*` tag |
| Profile | `GET /v2/insights` with `filter.type=urn:demographics` | Audience age and gender affinity |
| Profile | `GET /v2/insights` with `filter.type=urn:tag`, `filter.parents.types=urn:entity:brand`, `signal.location` | Brand-taste tags this audience over-indexes on, in this city |
| Rank | `GET /v2/insights` with `filter.type=urn:entity:brand`, `signal.interests.entities`, `signal.location`, `feature.explainability=true`, optional `filter.tags` | Brand affinity scores and per-signal contributions |
| Explain | `GET /v2/insights` with `filter.type=urn:demographics` on the top brands | Brand audience demographics, compared with the event audience |
| Explain | `GET /v2/insights` with `filter.type=urn:entity:place`, `filter.references_brand`, `filter.location` | The brand's locations in the event city, scored for this audience |

The less obvious parts: comparing the demographic affinity of the event audience against each brand's own audience (cosine similarity across Qloo's age buckets and gender), using `filter.references_brand` to turn a national brand into a local activation ("you have three stores within reach of this venue"), and using explainability to tell a sponsor which act on the bill is driving the match.

**Sponsor fit** (0 to 100) = 60% Qloo affinity + 25% audience tag overlap + 15% demographic alignment. Tag overlap is the mean audience affinity across the brand's Qloo tags. If a component is missing, the remaining weights are renormalized. The raw Qloo rank is always shown next to the re-ranked position.

Qloo affinity scores describe aggregate taste associations. SponsorMatch presents them that way and never as predictions about individual attendees or sales.

## Run it locally

Requires Node.js 22.19 or newer (developed on Node 24).

```sh
npm install
cp .env.example .env   # optional; leave values empty for mock mode
npm run dev            # http://localhost:3000
```

### Mock mode

With `QLOO_API_KEY` unset, the app runs fully offline against synthetic fixtures (`src/lib/qloo/fixtures/catalog.json`) that are shaped like the documented Qloo responses. The brands, places, IDs and scores in mock mode are invented; the UI labels them as mock data. With `NVIDIA_API_KEY` unset, pitches come from a deterministic template.

### Environment variables

Set these in `.env` locally or in the Vercel project settings. They are read only by server code and never sent to the browser.

| Variable | Required | Purpose |
| --- | --- | --- |
| `QLOO_API_KEY` | For live data | Qloo hackathon key. Sent as the `X-Api-Key` header to `https://hackathon.api.qloo.com`. |
| `NVIDIA_API_KEY` | For model pitches | NVIDIA API key for `https://integrate.api.nvidia.com/v1/chat/completions`. |
| `NVIDIA_MODEL` | No | Overrides the default model, `nvidia/nemotron-3-super-120b-a12b`. |

## Tests and checks

```sh
npm test          # unit tests (Vitest): Qloo client, mock client, ranking/evidence, pitches, agent pipeline
npm run lint      # ESLint (next/core-web-vitals + TypeScript)
npm run typecheck
npm run build
```

The Qloo client tests replay fixture responses through a fake `fetch`, so they make no network calls.

## Deploy

Deploys to Vercel as a standard Next.js app. Set the environment variables above in the project settings. The agent runs in a Node.js route handler (`src/app/api/match/route.ts`) that streams newline-delimited JSON events to the page.

## Project layout

```
src/app/page.tsx                 single page (server component passes only mode flags to the client)
src/app/api/match/route.ts       agent endpoint, streams step events
src/components/                  form, step timeline, audience panel, brand cards
src/lib/qloo/                    typed Qloo client, response normalization, mock client and fixtures
src/lib/agent/                   pipeline (the five steps) and pure ranking/evidence logic
src/lib/llm/                     Nemotron client and evidence-only pitch drafting
tests/                           unit tests and synthetic response fixtures
```

## Safeguards

- Keys stay on the server. The page receives only "live" or "mock" flags and the public model name.
- A Qloo 401 stops the run and blocks further Qloo calls from that server process for five minutes, so a bad key is never retried in a loop. Retries happen only on 429, 5xx and network errors, at most once, with bounded backoff.
- Identical Qloo requests are cached in server memory for ten minutes.
- No personal data is sent to Qloo: only public performer, venue, city and category names.

## Known limitations

- Brand demographics and local presence are fetched for the top six brands only, to keep each run to about 14 Qloo requests.
- Qloo's documentation describes per-result explainability without publishing its exact JSON layout; the parser assumes a list of `{ entity_id, score }` under `query.explainability["signal.interests.entities"]` and shows nothing if the layout differs.
- Pitch drafts are a starting point for the producer to edit, not a finished proposal.

## AI tools disclosure

This project was built with AI coding assistance. Claude Code (Anthropic) generated most of the initial code, tests and documentation under Alex Espinoza's direction. At runtime the app calls NVIDIA Nemotron to draft pitch text.

## License

[MIT](LICENSE)
