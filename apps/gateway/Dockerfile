# base's front door (base.win). No dependencies: Node's own http only.
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production PORT=10000
COPY package.json server.js ./
USER node
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
CMD ["node", "server.js"]
