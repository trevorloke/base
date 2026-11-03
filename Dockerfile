# Starsign — one container: API + the built web room. Workers and operators run the same image with a different command.
# Data: set DATABASE_URL (Postgres with pgvector; TimescaleDB optional) and REDIS_URL. Without them the API runs
# single-process on embedded PGlite at /data/pglite with in-process timers (dev/preview only).
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE} AS base
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

FROM base AS deps
# pnpm fetch needs only the lockfile, so this layer caches until dependencies change.
# (Copying packages/*/package.json with a wildcard flattens every file onto one name and breaks the workspace.)
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm --filter @starsign/web build

FROM base AS runtime
ENV NODE_ENV=production PORT=4000 PGLITE_PATH=/data/pglite
# Keep the heap inside a 512 MB instance (embedded PGlite needs room outside the JS heap).
ENV NODE_OPTIONS=--max-old-space-size=320
COPY --from=build /app /app
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:4000/api/health || exit 1
# Run Node directly: going through pnpm adds a second Node process, and corepack re-downloads pnpm
# for the non-root user on every boot. Same as `pnpm --filter @starsign/api start`.
WORKDIR /app/apps/api
CMD ["node", "--import", "tsx", "src/main.ts"]
