#!/usr/bin/env bash
#
# onboard.sh — go from a fresh clone to a running chat in ONE command.
#
# This is the "dev flow" onboarding path (Node + pnpm on your host). If you'd
# rather not install a toolchain at all, use the Docker path in docs/ONBOARDING.md.
#
# Usage (everything after the mode is forwarded verbatim to the CLI):
#   ./scripts/onboard.sh signup --invite <CODE> --username dustin
#   ./scripts/onboard.sh login  --username dustin
#
# It verifies Node 20+, enables pnpm via corepack, installs the workspace once,
# then drops you straight into the interactive client.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

die() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }
ok()  { printf '\033[32m✓ %s\033[0m\n' "$1"; }
info(){ printf '  %s\n' "$1"; }

if [ "$#" -lt 1 ]; then
  cat >&2 <<'USAGE'
usage:
  ./scripts/onboard.sh signup --invite <CODE> --username <name>
  ./scripts/onboard.sh login  --username <name>

Get an invite <CODE> from whoever runs the relay (see docs/ONBOARDING.md).
USAGE
  exit 1
fi

# 1. Node 20+ ---------------------------------------------------------------
command -v node >/dev/null 2>&1 || die "Node.js is not installed. Install Node 20 (https://nodejs.org) or use the Docker path in docs/ONBOARDING.md."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node $(node -v) found, but this project needs Node 20+. Upgrade Node, then re-run."
ok "Node $(node -v)"

# 2. pnpm (via corepack, no global install needed) --------------------------
if ! command -v pnpm >/dev/null 2>&1; then
  info "pnpm not found — enabling it via corepack…"
  corepack enable >/dev/null 2>&1 || die "Could not enable pnpm via corepack. Install pnpm 8 manually: npm i -g pnpm@8"
fi
ok "pnpm $(pnpm --version)"

# 3. Install the workspace once (idempotent — skips if already installed) ----
if [ ! -d node_modules ] || [ package.json -nt node_modules ] || [ pnpm-lock.yaml -nt node_modules ]; then
  info "Installing the workspace (this compiles the native libsignal + sqlite addons; ~1–2 min the first time)…"
  pnpm install --frozen-lockfile
else
  ok "Workspace already installed"
fi

# 4. Launch the CLI, forwarding all args (signup/login + flags) --------------
printf '\n\033[36m→ launching the signal-ai client…\033[0m\n\n'
exec pnpm --filter @signalai/cli dev -- "$@"
