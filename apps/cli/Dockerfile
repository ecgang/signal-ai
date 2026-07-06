# syntax=docker/dockerfile:1
#
# @signalai/cli — the terminal client, packaged so a non-developer can run it
# with ONLY Docker installed (no Node, no pnpm, no toolchain on the host).
#
# Build context is the REPO ROOT (a pnpm workspace):
#   docker build -f apps/cli/Dockerfile -t signalai .
#
# Run it interactively (the `-it` is REQUIRED for the full-screen TUI; without a
# TTY the CLI falls back to its plain readline shell). Mount a volume so your
# identity + ratchet state survive `docker run` invocations:
#   docker run -it -v signalai-state:/data signalai signup --invite <CODE> --username dustin
#   docker run -it -v signalai-state:/data signalai login  --username dustin
#
# CRITICAL (native module): the CLI persists one SQLite file per account via
# better-sqlite3 (a NATIVE module, through @signalai/client-sdk). It MUST be
# compiled for linux inside the image; the repo-root .dockerignore keeps the
# host's macOS node_modules out so `pnpm install` rebuilds it cleanly for linux.
#
# RUNTIME MODEL: identical to the agent/relay images — the workspace packages
# export `./src/*.ts` (paths->source), so `dist` is not runnable standalone and
# the process runs from TypeScript source via tsx. This is exactly what
# `pnpm --filter @signalai/cli dev` does locally.

# ---------------------------------------------------------------------------
# Stage 1: build — full workspace install, which fetches the prebuilt libsignal
# addon and compiles better-sqlite3 for linux via node-gyp.
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

# ---------------------------------------------------------------------------
# Stage 2: runtime — slim image, no build toolchain. The compiled
# better-sqlite3 .node and the libsignal addon ride along in node_modules.
# ---------------------------------------------------------------------------
FROM node:20-slim AS runtime

RUN corepack enable && corepack prepare pnpm@8.10.3 --activate

WORKDIR /app
COPY --from=build /app /app

# One SQLite file per account lives here; mount a volume at /data to persist
# identity + ratchet across `docker run` invocations. Overridable, but this is
# the default the run examples above assume.
ENV SIGNALAI_STATE_DIR=/data
RUN mkdir -p /data

# Run the CLI from TS source via tsx — the same path as `pnpm … cli dev`.
# Everything after the image name is forwarded as CLI argv, so
# `docker run … signalai signup --invite X --username dustin` works verbatim.
ENTRYPOINT ["sh", "-c", "exec pnpm --filter @signalai/cli exec tsx src/main.ts \"$@\"", "sh"]
