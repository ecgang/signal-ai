# syntax=docker/dockerfile:1
#
# @signalai/agent — the headless AI member. Signs up / resumes through the
# same SDK as a human and persists identity + ratchet + context to SQLite
# (better-sqlite3, a NATIVE module) via @signalai/client-sdk.
#
# Build context is the REPO ROOT (a pnpm workspace):
#   docker build -f apps/agent/Dockerfile .
#
# CRITICAL (native module): better-sqlite3 MUST be compiled for linux inside
# the image. The repo-root .dockerignore excludes host node_modules so the
# macOS build never leaks in; `pnpm install` here rebuilds it for linux.
#
# RUNTIME MODEL: same paths->source design as the relay — dist is not runnable
# standalone, so the process runs from TypeScript source via tsx. The `tsc`
# build runs in-stage only to type-check.

# ---------------------------------------------------------------------------
# Stage 1: build — full workspace install (rebuilds better-sqlite3 for linux),
# prisma generate (relay is a transitive build dep), type-check build.
# ---------------------------------------------------------------------------
FROM node:20-slim AS build

ENV CI=1
# Toolchain to compile better-sqlite3 for linux via node-gyp.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@8.10.3 --activate

WORKDIR /app
COPY . .

RUN pnpm install --frozen-lockfile

# @signalai/agent... builds relay too (a devDep in the graph), which needs the
# generated Prisma client to type-check.
RUN pnpm --filter @signalai/relay exec prisma generate
RUN pnpm --filter @signalai/agent... run build

# ---------------------------------------------------------------------------
# Stage 2: runtime — slim image, no build toolchain. The compiled
# better-sqlite3 .node comes along inside the copied node_modules.
# ---------------------------------------------------------------------------
FROM node:20-slim AS runtime

ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@8.10.3 --activate

WORKDIR /app
COPY --from=build /app /app

# Persist the agent's SQLite state (identity/ratchet) across restarts by
# mounting a Railway volume at /data. Default is ./agent-state.sqlite.
ENV AGENT_DB_PATH=/data/agent-state.sqlite
RUN mkdir -p /data

# Launch the agent from source via tsx (runs in apps/agent).
CMD ["sh", "-c", "exec pnpm --filter @signalai/agent exec tsx src/index.ts"]
