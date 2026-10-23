# Deploy

The kit says `qloo mcp` must run on "a VM or container"; serverless functions are not a supported route. SponsorMatch ships as a Docker image for a long-running Node host. `GET /api/health` reports readiness (in live mode it calls `qloo_capabilities`, which does not use Qloo quota).

## Render (Blueprint included)

1. In Render, choose **New > Blueprint** and select the repo. Render reads `render.yaml` (Docker web service, health check `/api/health`).
2. When prompted, paste `QLOO_API_KEY` and `NVIDIA_API_KEY`. The other variables are preset in `render.yaml`.
3. Deploy, then open `/api/health`: it should show `"ok": true`.

The free plan sleeps when idle, so the first request after a pause is slow. Use a paid instance during judging if that matters.

## Railway

1. **New Project > Deploy from GitHub repo**. Railway detects the `Dockerfile`.
2. In **Variables**, add `QLOO_API_KEY` and `NVIDIA_API_KEY`. Optionally `NVIDIA_MODEL`, `QLOO_BASE_URL` and `QLOO_TRUSTED_BASE_URL` (both `https://hackathon.api.qloo.com`).
3. In **Settings > Networking**, generate a domain and set the health check path to `/api/health`.

## Any Docker host

```sh
docker build -t sponsormatch .
docker run -p 3000:3000 -e QLOO_API_KEY -e NVIDIA_API_KEY sponsormatch
```

## Smoke test the harness locally

```sh
npm run smoke:mcp   # starts node_modules' qloo mcp, lists tools, calls qloo_capabilities (no Qloo request)
```

Route timeouts: `/api/optimize` allows 300 s and `/api/sponsor` 120 s; a typical live optimizer run makes about 24 Qloo tool calls at roughly 0.5 s each, plus up to 10 Nemotron calls.
