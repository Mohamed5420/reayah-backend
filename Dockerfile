# Reaya+ API image. Build: docker build -t reaya-api .   Run: see deploy/docker-compose.yml.
# Node version follows .nvmrc (22 LTS).

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production PORT=3000
WORKDIR /app
# Only what runs: compiled JS, production node_modules, package.json. Locales are imported as JSON by the build.
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3000
# Ready = MongoDB and Redis answer (GET /api/v1/health/ready).
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/v1/health/ready >/dev/null || exit 1
# Node handles SIGTERM itself (graceful shutdown in src/index.ts).
CMD ["node", "dist/index.js"]
