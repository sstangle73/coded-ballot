# coded-ballot server, Docker target: Node + SQLite + local disk. Build from the repo root:
#   docker build -t coded-ballot .
# Node runs the TypeScript directly (type stripping), so the image holds the same source files as the repo.

FROM node:24-alpine AS web
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci --ignore-scripts && (npm run build -w @coded-ballot/web --if-present || true) && mkdir -p packages/web/dist

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
RUN npm ci --omit=dev --ignore-scripts -w @coded-ballot/core -w @coded-ballot/server

FROM node:24-alpine
ENV NODE_ENV=production DATA_DIR=/data PORT=8080 STATIC_DIR=/app/packages/web/dist
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages/core/package.json packages/core/
COPY packages/core/src packages/core/src
COPY packages/server/package.json packages/server/
COPY packages/server/src packages/server/src
COPY packages/server/migrations packages/server/migrations
COPY --from=web /app/packages/web/dist packages/web/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "packages/server/src/targets/node.ts"]
