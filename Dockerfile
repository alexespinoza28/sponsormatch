# SponsorMatch: long-running Node server. The app spawns the Qloo harness
# (`qloo mcp`, from node_modules) as a child process, so it needs a container
# or VM host, not serverless functions. Node >= 22.19 is required by the harness.

FROM node:24.21.0-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24.21.0-bookworm-slim AS run
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    QLOO_HOME=/tmp/sponsormatch-qloo-home
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json /app/next.config.ts ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
USER node
EXPOSE 3000
# Secrets (QLOO_API_KEY, NVIDIA_API_KEY) come from the host's environment at runtime, never the image.
CMD ["sh", "-c", "exec node_modules/.bin/next start -H 0.0.0.0 -p \"${PORT:-3000}\""]
