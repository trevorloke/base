# base ground — one container: API + public pages + the built web app.
# It sits at the repository root and builds with the root as its context, so
# the production service's Docker settings stayed the same when Starbase
# moved into apps/ground. The other apps build from their own folders.
# Data: set DATABASE_URL for hosted Postgres (recommended), or mount a volume
# at /data for the embedded database.
# Base image is overridable, e.g. --build-arg NODE_IMAGE=mirror.gcr.io/library/node:22-alpine

ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY apps/ground/package.json apps/ground/package-lock.json ./
COPY apps/ground/shared/package.json shared/
COPY apps/ground/server/package.json server/
COPY apps/ground/web/package.json web/
RUN npm ci
COPY apps/ground/ ./
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3200 \
    BASE_DATA=/data/base-ground
COPY apps/ground/package.json apps/ground/package-lock.json ./
COPY apps/ground/shared/package.json shared/
COPY apps/ground/server/package.json server/
COPY apps/ground/web/package.json web/
RUN npm ci --omit=dev && npm cache clean --force
COPY apps/ground/shared ./shared
COPY apps/ground/server ./server
COPY --from=build /app/web/dist ./web/dist
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3200
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/api/health || exit 1
CMD ["node", "server/index.js"]
