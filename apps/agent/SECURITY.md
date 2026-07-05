# `@signalai/agent` — security posture

## At-rest state (SQLite)

The agent persists its full account state to a SQLite database at `AGENT_DB_PATH`
(default `./agent-state.sqlite`, gitignored via `*.sqlite`). That state includes:

- the relay bearer **token**,
- the device **identity key pair** (private key) + registration id,
- all **Signal session/ratchet records** (the serialized `InMemoryClientStores`),
- the **per-conversation rolling context** (decrypted message text the agent
  keeps to prompt the LLM) and mode bookkeeping.

This is sensitive material. Treat the database file as a secret.

### Encryption at rest — controlled by `AGENT_DB_KEY`

- **`AGENT_DB_KEY` set** → every JSON payload column (`client_state`,
  `context_windows`, `conversation_meta`) is sealed with **AES-256-GCM** using
  Node's standard-library `crypto` (`createCipheriv`/`createDecipheriv`). The
  256-bit key is derived with `scrypt(AGENT_DB_KEY, salt)` against a per-database
  random 16-byte salt stored in `store_meta`. No cryptography is invented —
  standard-mode primitives only. The IV (12 bytes) and GCM auth tag (16 bytes)
  are stored alongside each ciphertext; a tampered payload fails decryption.
- **`AGENT_DB_KEY` unset** → **payloads are stored as plaintext JSON.** The
  database is readable by anyone with filesystem access. This is the default and
  is acceptable only for local development / trusted single-tenant hosts.

The encrypted-vs-plaintext choice is recorded in `store_meta.encrypted` at
creation time. Re-opening a plaintext database **with** a key (or an encrypted
database **without** one) fails fast rather than corrupting reads — to switch
modes, start from a fresh `AGENT_DB_PATH`.

> Note: `better-sqlite3-multiple-ciphers` (whole-file SQLCipher-style
> encryption) was **not** adopted this pass; application-level AES-256-GCM of the
> payload columns is the implemented mechanism. Column names, row counts, and
> conversation ids are therefore visible even when payloads are encrypted; the
> message text, keys, and token are not.

## Revocation model (member removal)

When the agent is removed from a conversation, revocation is enforced at the
**transport layer** — not by destroying key material:

- **Local context purge** — the agent purges that conversation's rolling context
  window and drops its local conversation-cache entry. Detection is autonomous
  via a periodic membership-reconciliation sweep (`AGENT_RECONCILE_INTERVAL_MS`,
  default 30 s; `0` disables it), because a removed member receives no further
  messages and the SDK suppresses `memberRemoved` for the client's own removal.
- **Relay-enforced non-delivery** — the relay's phase-4 two-gate refuses BOTH
  live-push and reconnect-drain of any envelope addressed to the removed member.
- **Senders cease fan-out** — remaining members stop encrypting for the removed
  member.
- **Pairwise session key material is intentionally NOT deleted.** Sessions are
  keyed by peer identity+device and are **shared across every conversation with
  that peer**, so deleting one on removal would corrupt unrelated conversations.
  Core exposes no session-delete API by design (see `packages/core/src/group.ts`).

## Secrets

- LLM API keys (`AGENT_LLM_API_KEY`, `ANTHROPIC_API_KEY`) and `AGENT_DB_KEY` are
  read from the environment only. None are committed. `.env*` is gitignored and
  write-blocked by a repo hook.

## Logging

- Message bodies and identity/private keys are **never logged at info level**.
  Plaintext logging is gated behind `DEBUG_PLAINTEXT` and emitted only at
  `console.debug`. Error logs carry `Error.message` only, never plaintext bodies.
