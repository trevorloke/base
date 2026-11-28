# base.win: one container, the API, public pages and the built web app.
# Data: set DATABASE_URL for hosted Postgres (recommended), or mount a volume
# at /data for the embedded database.
# Base image is overridable, e.g. --build-arg NODE_IMAGE=mirror.gcr.io/library/node:22-alpine

ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
# IMAGE_DATA_DIR is not a setting: it is where the built-in database goes
# when neither BASE_DATA nor its older name is set on the service, so a
# folder set there on purpose always wins (server/db/client.js). An older
# folder already on the disk at /data is still used while it is the only one.
ENV NODE_ENV=production \
    PORT=3200 \
    IMAGE_DATA_DIR=/data/base-win
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev && npm cache clean --force
COPY shared ./shared
COPY server ./server
# HR-1's three read-only counts, run by hand in Render's Shell (GOING-LIVE.md)
COPY scripts/hr-counts.mjs ./scripts/hr-counts.mjs
# The read-only finder of the product's older name in stored text (counts only), for Render's Shell
COPY scripts/find-old-word.mjs ./scripts/find-old-word.mjs
COPY --from=build /app/web/dist ./web/dist
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3200
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/api/health || exit 1
CMD ["node", "server/index.js"]
