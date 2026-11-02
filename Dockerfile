# Starsign — one container: API + the built web room. Workers and operators run the same image with a different command.
# Data: set DATABASE_URL (Postgres with pgvector; TimescaleDB optional) and REDIS_URL. Without them the API runs
# single-process on embedded PGlite at /data/pglite with in-process timers (dev/preview only).
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE} AS base
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/*/package.json ./packages/
COPY apps/*/package.json ./apps/
# restore the directory layout pnpm expects for workspace packages
RUN set -e; for f in packages/*.json; do n=$(basename "$f" .json); mkdir -p "packages/$n" && mv "$f" "packages/$n/package.json"; done; \
    for f in apps/*.json; do n=$(basename "$f" .json); mkdir -p "apps/$n" && mv "$f" "apps/$n/package.json"; done
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter @starsign/web build

FROM base AS runtime
ENV NODE_ENV=production PORT=4000 PGLITE_PATH=/data/pglite
COPY --from=build /app /app
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:4000/api/health || exit 1
CMD ["pnpm", "--filter", "@starsign/api", "start"]
