# signal-ai — security posture & threat model

This is the honest threat model for the whole system (relay, clients, and the AI
member). It makes **scoped** claims: where a property holds, it names the exact
mechanism; where it does not, it says so plainly. No cryptography is invented —
messages use libsignal's X3DH/PQXDH + Double Ratchet via `@signalapp/libsignal-client`.

## Relay trust boundary

The relay (`apps/relay`) is the only always-on server. It is **trusted for
availability and membership coordination, but never for confidentiality**:

- **It only ever stores ciphertext.** Message bodies are sealed pairwise with
  libsignal before they reach the relay; the relay persists opaque envelopes and
  cannot read message content. It holds no member private keys, so it cannot
  forge a message any member will decrypt.
- **It sees metadata, and this is not hidden in the MVP:** account/username and
  device ids, which conversations exist and who belongs to them, message
  timestamps, sizes, and delivery/online patterns. Treat the social graph and
  timing as visible to whoever operates the relay.
- **Membership is relay-coordinated, not cryptographically enforced.** There is
  no MLS / Sender-Keys group protocol in this MVP: the relay is the source of
  truth for who is in a thread, and clients fan out encryption to whatever member
  list it reports. A malicious or compromised relay could therefore add a member,
  lie about the member list, or withhold a removal. This is the central,
  deliberate trade-off of Architecture B and the reason claims here stay scoped.
- **Revocation depends on relay honesty** (see the revocation model below): the
  transport-layer two-gate is enforced *by the relay*. An honest relay refuses
  delivery to a removed member; a dishonest relay that retained old ciphertext
  could still deliver it. Removal is not modelled as cryptographic erasure.
- **Signup is gated by invite codes** (`INVITE_CODES`) and every socket is
  authenticated with a per-account bearer token. A token grants a member's own
  traffic only — it is not a member of any thread and cannot read others' traffic.

### Membership op-log & late-join

A signed, hash-chained membership op-log (`@signalai/membership`) runs alongside
the relay's member list. Clients stamp their current op-log head into each
(ratchet-encrypted) message and a **fail-closed receiver gate** (`enforceInbound`)
authorizes every inbound message against the RECEIVER'S own current head — a
removed sender is rejected no matter which head it cites, and a message with no
head is rejected. This adds client-side membership enforcement on top of the
relay's coordination; it does not replace it, and two honest scope limits apply:

- **Late-join genesis is relay-served and TRUSTED (not yet pinned).** A member
  invited mid-conversation backfills the op-log genesis→tail by asking the relay
  to re-drain it (client-driven `subscribe`). The relay orders/dedupes ops by
  cleartext `seq` and never decodes op bodies, but it *is* the source of the
  genesis chain the joiner folds. A malicious relay could serve a forged genesis
  chain until the out-of-band **InvitePin** TOFU (genesisHash + pinnedHead) is
  wired in to pin it. Pinning is the tracked follow-up (`FOLLOW-UP(InvitePin)`).
  The backfill fires from two sites: an explicit `listMembers` refresh, and — for a
  consumer that adopts a conversation inside its `onMessage` handler and never calls
  `listMembers` first — the receive path itself, one-shot on the first inbound
  message (adopt-on-first-message), before the gate decides.
- **A message in the pre-catch-up window is best-effort dropped.** A message that
  arrives at a joiner after her REST-invite but before her catch-up completes is
  gate-rejected and dropped (acked so the relay stops redelivering), not queued
  for replay. Join is made synchronous (the invite path awaits chain-readiness,
  bounded) to keep this window narrow, but delivery inside it is not guaranteed.

## The AI member and inference — where plaintext goes

The AI is a **member/endpoint**, not the transport: it holds its own libsignal
identity keys, is added by explicit invite, appears in the member list, and is
removable. Messages remain end-to-end encrypted — the relay never sees plaintext
whether or not the AI is present. But any AI that *reads* messages must decrypt
them somewhere, and **where** it runs inference determines who else sees that
plaintext:

- **Remote provider (default, and how the hosted demo runs).** With
  `AGENT_LLM_BASE_URL` pointed at a third-party OpenAI-compatible API (e.g. NVIDIA
  NIM / Nemotron, or Anthropic), the agent **forwards the conversation's decrypted
  text to that provider** on every reply. For those messages, confidentiality
  extends only as far as your trust in that provider — the plaintext leaves the
  end-to-end boundary. This is a member you invited relaying content to its model
  host, not a break in the transport crypto, but the effect on confidentiality is
  real and is disclosed here explicitly. **Inviting `@ai` is consent to this.**
- **Local provider (recommended for privacy).** Point `AGENT_LLM_BASE_URL` at a
  model running on hardware you control (e.g. Ollama on `http://localhost:11434/v1`).
  The plaintext never leaves that machine — no third party. No code change; the
  LLM layer is provider-agnostic.
- **Local knowledge (`AGENT_VAULT_PATH`).** When enabled, retrieved notes are
  injected into the model's prompt. Under a **remote** provider those notes are
  sent to the provider along with the messages; under a **local** provider they
  stay on-device. Enable vault access only with local inference unless you accept
  sending your notes to the provider.

Full rationale, model sizing, the FHE-infeasibility verdict, and the TEE/P2P
roadmap are in [`docs/CONFIDENTIAL-INFERENCE.md`](docs/CONFIDENTIAL-INFERENCE.md).

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
