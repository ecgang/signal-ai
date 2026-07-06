# syntax=docker/dockerfile:1
#
# @signalai/node — Fastify process shell over a ciphertext-only MailboxService
# (store-and-forward) plus the demoted relay's membership/prekey-directory
# routes. Those routes are FENCED (see src/index.ts, src/db.ts —
# `// AUTHORITY — removed in P2 (Plan 004)`), not deleted: this node still
# holds live membership authority until Plan 004's signed op-log replaces it,
# so it is not yet a "blind peer" end to end (design docs/design/p2p-transport.md
# §B.3, §F.6; plans/003-p1-node-demotion.md).
#
# Build context is the REPO ROOT (a pnpm workspace):
#   docker build -f apps/node/Dockerfile .
#
# RUNTIME MODEL: the workspace packages export TypeScript SOURCE
# (packages/*/package.json "exports" -> ./src/index.ts), and a `tsc` build
# emits `dist` whose bare `@signalai/*` imports resolve back to that .ts
# source at runtime — i.e. dist is NOT runnable standalone (documented build
# debt). The proven run path is therefore tsx-from-source, exactly how the
# CLI runs. We still run the `tsc` build in-stage to type-check, but the
# process is launched with tsx.
#
# ENTRYPOINT runs `prisma migrate deploy` (schema at apps/node/prisma, URL
# from DATABASE_URL via apps/node/prisma.config.ts) BEFORE binding the port.

# ---------------------------------------------------------------------------
# Stage 1: build — full workspace install, prisma generate, type-check build.
# ---------------------------------------------------------------------------
FROM node:20-slim AS build

ENV CI=1
# Toolchain for any native module compilation during install (node-gyp).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@8.10.3 --activate

WORKDIR /app
COPY . .

# Deterministic install of the whole workspace (source is consumed across
# packages, so a filtered/prod-only install would drop needed sibling source
# and the tsx dev runner).
RUN pnpm install --frozen-lockfile

# Generate the Prisma client (into node_modules) and type-check-build the node.
RUN pnpm --filter @signalai/node exec prisma generate
RUN pnpm --filter @signalai/node... run build

# ---------------------------------------------------------------------------
# Stage 2: runtime — slim image, no build toolchain. Runs from TS source.
# ---------------------------------------------------------------------------
FROM node:20-slim AS runtime

ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@8.10.3 --activate

WORKDIR /app
# node_modules is already linux-native (built in stage 1); COPY preserves the
# pnpm symlink farm.
COPY --from=build /app /app

# Binds 0.0.0.0:PORT (default 8080; Railway injects PORT). Health: /health.
EXPOSE 8080

# Apply pending migrations, then launch the node from source via tsx.
# `pnpm --filter ... exec` runs in apps/node, so prisma.config.ts and
# src/index.ts resolve correctly.
CMD ["sh", "-c", "pnpm --filter @signalai/node exec prisma migrate deploy && exec pnpm --filter @signalai/node exec tsx src/index.ts"]
