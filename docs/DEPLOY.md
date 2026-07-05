# Deploying signal-ai to Railway

Prod backbone for the v0.1 alpha: **Postgres + relay + agent** on Railway.
This document is deploy-time reference only — it contains env var **names**,
never values. All secret values live in Railway's per-service environment.

> Canonical relay domain (fill in at provisioning, use everywhere):
> `relay-production-fe4c.up.railway.app`  (e.g. `signal-ai-relay-production.up.railway.app`)

---

## Architecture

| Service   | Source            | Build            | Public? | Notes |
|-----------|-------------------|------------------|---------|-------|
| postgres  | Railway plugin    | —                | no      | Managed Postgres; provides `DATABASE_URL`. |
| relay     | `apps/relay/Dockerfile` | Dockerfile | yes (`/health`) | Migrates on boot, then serves REST + WS. |
| agent     | `apps/agent/Dockerfile` | Dockerfile | no      | Headless AI member; connects to the relay. |

Both images build from the **repo root** context and run from TypeScript
source via `tsx` (the workspace packages export `./src/*.ts`; a compiled
`dist` is not runnable standalone — see the Dockerfile header comments). The
runtime stage drops the build toolchain (`python3/make/g++`) to slim the
image; the agent's native `better-sqlite3` is compiled for linux in the build
stage.

---

## Build config (root `railway.json` + per-service `RAILWAY_DOCKERFILE_PATH`)

Both services are separate Railway services in the **same** project, deploying
from the **same** repo. Build config is split in two:

- **`railway.json`** (repo root, committed, **service-agnostic**) — only says
  `build.builder = "DOCKERFILE"` and the restart policy. It deliberately does
  **not** name a Dockerfile, so it is correct for every service.
- **`RAILWAY_DOCKERFILE_PATH`** — a **Railway environment variable set
  per-service** (never committed) that selects which Dockerfile that service
  builds:
  - relay service → `RAILWAY_DOCKERFILE_PATH=apps/relay/Dockerfile`
  - agent service → `RAILWAY_DOCKERFILE_PATH=apps/agent/Dockerfile`

Set it in the Railway dashboard (service → **Variables**) or via CLI:

```
railway variables --service relay --set RAILWAY_DOCKERFILE_PATH=apps/relay/Dockerfile
railway variables --service agent --set RAILWAY_DOCKERFILE_PATH=apps/agent/Dockerfile
```

There is **no** `apps/agent/railway.json` and no `RAILWAY_CONFIG_FILE` — the
single root `railway.json` plus each service's `RAILWAY_DOCKERFILE_PATH` is the
whole mechanism.

---

## Environment variables (NAMES ONLY — set values in Railway)

### relay

| Name           | Purpose |
|----------------|---------|
| `DATABASE_URL` | Postgres connection string. Reference the Postgres plugin's variable. Used by both `prisma migrate deploy` (via `apps/relay/prisma.config.ts`) and the runtime pg adapter. |
| `INVITE_CODES` | Comma-separated list of invite codes gating `/signup` (closed alpha). |
| `PORT`         | Listen port. Railway injects this automatically; relay defaults to `8080` if unset. |
| `NODE_ENV`     | Optional; image defaults to `production`. |

### agent

| Name                | Purpose |
|---------------------|---------|
| `RELAY_URL`         | Base URL of the relay = `https://relay-production-fe4c.up.railway.app` (WS is derived from it). |
| `INVITE_CODE`       | A single invite code the agent uses to sign up — must be one of the relay's `INVITE_CODES`. |
| `AGENT_PROVIDER`    | LLM provider: `openai-compatible` (default) or `anthropic`. |
| `AGENT_LLM_BASE_URL`| OpenAI-compatible base URL (default NVIDIA NIM `https://integrate.api.nvidia.com/v1`). |
| `AGENT_LLM_API_KEY` | LLM API key (**secret**). |
| `AGENT_MODEL`       | Model id (OpenAI-compatible provider). **Set this explicitly to a model your account can invoke** — listing a model at `/v1/models` does not guarantee it is provisioned for your key (an unprovisioned id returns `404` at call time). A confirmed-working NVIDIA NIM Nemotron for this deploy is `nvidia/llama-3.3-nemotron-super-49b-v1`. |
| `AGENT_DB_KEY`      | Encryption key for the agent's SQLite state (**secret**). |
| `AGENT_USERNAME`    | Optional; relay username for the AI member (default `ai`). |
| `AGENT_HANDLE`      | Optional; mention handle (default `@ai`). |
| `AGENT_DB_PATH`     | Optional; SQLite path. Image default `/data/agent-state.sqlite` — mount a Railway volume at `/data` to persist identity/ratchet across restarts. |

> Anthropic path: set `AGENT_PROVIDER=anthropic` and provide `AGENT_LLM_API_KEY`
> (Anthropic key); `AGENT_MODEL` then defaults to `claude-sonnet-5`.

Never commit any of the above values. The public repo/logs are grepped for
secret material before push.

---

## Migrations (on boot)

The relay image's entrypoint runs:

```
prisma migrate deploy   # applies apps/relay/prisma/migrations against DATABASE_URL
exec tsx src/index.ts   # then binds the port
```

`prisma migrate deploy` is idempotent (only applies pending migrations), so it
is safe on every relay restart/redeploy. No manual migration step is required
after the first deploy — add new migrations to `apps/relay/prisma/migrations`
and redeploy.

---

## Persistence

- **relay**: stateless beyond Postgres. Losing the relay container loses nothing.
- **agent**: identity + ratchet + conversation context live in
  `AGENT_DB_PATH`. Mount a Railway **volume at `/data`** so a redeploy does not
  regenerate the AI member's identity (which would break existing sessions).

---

## Health & connectivity

- Relay healthcheck: `GET /health` → `200` with `{ db: "ok" }` when Postgres is
  reachable. The root `railway.json` does not pin a healthcheck path (it stays
  service-agnostic) — set the relay service's **Healthcheck Path** to `/health`
  in Railway (service → Settings → Healthcheck) so failed deploys don't go live.
- WS clients connect to `wss://relay-production-fe4c.up.railway.app/ws`.

---

## Rollback

- **App code**: Railway keeps prior deploys — use **Redeploy** on the last
  known-good deployment for the relay/agent service to roll back the image.
- **Database**: `prisma migrate deploy` only rolls **forward**. To undo a
  schema change, ship a new *down* migration (Prisma has no auto-rollback);
  restore from a Postgres backup only as a last resort. Because the relay
  stores ciphertext + routing metadata only, prefer forward-fixing over
  restore.
- Redeploying an older relay image whose migrations are a subset of what's
  already applied is safe (`migrate deploy` is a no-op for already-applied
  migrations), but do **not** redeploy an image expecting a *newer* schema
  than the DB has.
