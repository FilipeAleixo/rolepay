# The Rolepay server (apps/server) for Fly.io: fly.demo.toml (Moderato testnet) and fly.app.toml
# (mainnet). How to deploy: apps/server/README.md, "Deploying".
#
# deps: the server's production dependencies only (no test tooling), with better-sqlite3's native
# addon built for this platform. Runtime: Node 22 slim with those node_modules and the TypeScript
# sources, run with tsx exactly as `pnpm start` does, by the unprivileged `node` user. The SQLite
# file lives on the volume mounted at /data.

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS deps
# A compiler for better-sqlite3 when no prebuilt binary matches this platform.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/discord/package.json packages/discord/
COPY packages/web/package.json packages/web/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --prod --filter @rolepay/server...

FROM node:${NODE_VERSION}-bookworm-slim
ENV NODE_ENV=production \
  ROLEPAY_DB_PATH=/data/rolepay.db
WORKDIR /app
COPY --from=deps /app /app
# Sources only (.dockerignore drops tests, docs, databases and .env). The client bundle is built
# from packages/web/src/client with esbuild on the first page request, as in development.
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
WORKDIR /app/apps/server
EXPOSE 8787
# Fly mounts the volume at /data owned by root: hand it to `node`, then run the server as `node`
# (setpriv execs it, so it receives SIGTERM directly and shuts down cleanly).
CMD ["sh", "-c", "mkdir -p /data && chown node:node /data && exec setpriv --reuid=node --regid=node --init-groups node --import tsx src/main.ts"]
