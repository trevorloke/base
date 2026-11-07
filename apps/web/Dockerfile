# syntax=docker/dockerfile:1
# base web: the client's public website and its admin, as one Node server.
# Build context: apps/web. Render builds this for each client's web service
# (SETUP.md, "Put the website online with Render").
#
# The image is built without the database or any secret: public pages then
# render when they are asked for (src/lib/server/render-time.ts), reading
# through the data cache. Migrations and the seed run when the container
# starts, before the server (scripts/predeploy.ts): if they fail, the new
# deploy never goes live and the current site stays up.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    ICU_TIMEZONE_FILES_DIR=/app/tzdata
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Public values are built into the pages. Render passes a service's
# environment variables to the build as these arguments; secrets are never
# declared here, so none of them end up in the image.
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY
ARG NEXT_PUBLIC_PLAUSIBLE_DOMAIN
ARG NEXT_PUBLIC_GA_MEASUREMENT_ID
ARG RENDER_GIT_COMMIT
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_TURNSTILE_SITE_KEY=$NEXT_PUBLIC_TURNSTILE_SITE_KEY \
    NEXT_PUBLIC_PLAUSIBLE_DOMAIN=$NEXT_PUBLIC_PLAUSIBLE_DOMAIN \
    NEXT_PUBLIC_GA_MEASUREMENT_ID=$NEXT_PUBLIC_GA_MEASUREMENT_ID
RUN npx next build && npm run build:predeploy && echo "${RENDER_GIT_COMMIT:-}" > .next/standalone/COMMIT

FROM node:22-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=10000 \
    ICU_TIMEZONE_FILES_DIR=/app/tzdata
# The standalone server, its static files, the public folder, current
# time-zone rules (tzdata/README.md), the migrations and the bundled
# migrate-and-seed step. The server writes its page and data cache under
# .next, so the app's files belong to the user it runs as.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/tzdata ./tzdata
COPY --from=build --chown=node:node /app/drizzle ./drizzle
COPY --from=build --chown=node:node /app/dist/predeploy.mjs ./predeploy.mjs
USER node
EXPOSE 10000
CMD ["sh", "-c", "export BASE_WEB_COMMIT=\"${BASE_WEB_COMMIT:-$(cat COMMIT 2>/dev/null)}\"; node predeploy.mjs && exec node server.js"]
