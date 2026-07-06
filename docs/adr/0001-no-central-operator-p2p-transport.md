# ADR 0001 — No central operator: P2P transport is the target end-state

- **Status:** Accepted (direction), Not yet implemented
- **Date:** 2026-07-05
- **Deciders:** Eric
- **Supersedes:** nothing (records a vision correction)
- **Related:** [`CONFIDENTIAL-INFERENCE.md`](../CONFIDENTIAL-INFERENCE.md), [`DEPLOY.md`](../DEPLOY.md), `~/vault/Research/Pears Runtime - P2P Serverless Analysis for signal-ai.md`

## Context

signal-ai currently ships its MVP on a **Railway-hosted relay** (`apps/relay`, Fastify +
Postgres): ciphertext store-and-forward, a prekey/key directory, invite gating, and
username→identity resolution. That relay was the fastest path to a *working* E2EE product
with a *real second user* (Dustin). It is ciphertext-only — it cannot read messages — but
it **is a central operator**: it sees the social graph and timing metadata, and it is a
machine we run that the whole network depends on.

The product's north star, corrected here, is **discretion via no central operator** — the
ethos behind bitchat/nostr, delivered over the internet so remote friends still work. The
question that triggered this ADR was "do we still need Railway if we go more P2P?" A cited
research pass on the Pears Runtime / Holepunch stack (see Related) produced the honest
answer below.

## What "P2P / serverless" actually buys us (and what it doesn't)

Pears' own docs are explicit: **"serverless" describes the trust and data model, not the
absence of always-on machines.**

- **Removed:** the central *routing/account* server. Peers connect directly by public key,
  end-to-end encrypted, via the HyperDHT — no message transits a machine we operate.
  This is the real win and it is the property we actually want.
- **NOT removed by P2P alone:**
  1. **Async delivery to an offline peer.** Hypercore has no store-and-forward mailbox. If
     the recipient is offline, the message waits until *some* peer holding it is online.
     Pears' own fix is a **"blind peer"** — which their docs literally call *"putting the
     server in serverless"* (run under systemd). An always-on data-holder is still required.
  2. **NAT traversal fallback.** Hole-punching is "not guaranteed on symmetric-NAT," so
     there is a hosted `relayThrough` relay fallback — another always-on machine.
  3. **DHT bootstrap nodes.** Well-known first-hop machines (Holepunch runs the defaults;
     they are overridable).
  4. **Name→key directory.** Pears is purely key-based; human-readable name mapping is the
     app's job.

The crucial nuance: a **blind peer holds ciphertext only** — it keeps messages available
for offline peers *without* seeing the social graph. So P2P doesn't delete the always-on
box; it **strips the box of its metadata visibility** and makes it self-hostable.

## Decision

1. **Target end-state: no central operator we run.** The P2P transport (Pears/hyperswarm,
   and/or nostr for internet-bridged delivery) is the intended replacement for the hosted
   relay's *routing* role. This is a **transport swap, not a rewrite** — Signal protocol is
   transport-agnostic (it's bytes over any wire).

2. **Keep libsignal. Do not adopt Noise.** "bitchat-like" refers to the mesh/no-operator
   *ethos*, which is separable from bitchat's crypto choice. Double Ratchet over a P2P
   substrate is stronger than Noise XX for a long-lived group chat. We invent no crypto.

3. **The always-on box doesn't disappear — it becomes optional and self-hostable.** Offline
   delivery is served by a **blind peer (ciphertext-only availability node)**. The default
   install is pure local-first P2P with no node and no operator; power users optionally run
   **one** node.

4. **AI hosting model: local-first, optional user-run node — never a central operator.**
   - **Default:** the AI model runs **on a participant's own device**, on-demand, live only
     while that human is online. Most discreet; gives up "AI always in the loop over days."
   - **Optional upgrade:** a user runs **their own always-on node** for a bigger/better
     (cloud) model. Self-sovereign, not a server we operate.
   - **Synthesis:** the AI node and the blind-peer mailbox are **the same self-hosted node**.
     One concept — *"run your own node for always-on + a better model"* — covers both the
     AI hosting and the offline-availability gap.

5. **Sequencing: the MVP relay stays until it's earned its replacement.** Do not destabilize
   the transport before Dustin has actually used the product. The Railway relay is the
   layer we built first and swap later; the P2P transport is a **roadmap track**, gated
   through architecture review (Liotta-tier) and plan review before any code.

## What survives the pivot vs. what changes

| Survives intact | Changes (the transport layer) |
|---|---|
| `packages/core` — libsignal wrapper, sessions, pairwise fan-out | `apps/relay` — becomes a blind-peer availability node, or is dropped for a DHT |
| `apps/cli` + the full-screen TUI (product surface) | Transport in `packages/client-sdk` — relay client → P2P substrate |
| The AI-member-as-endpoint design (`apps/agent`) | Wire frames in `packages/proto` — REST/WS relay frames → P2P messaging |
| The `/verify` out-of-band trust surface | Key directory → prekey distribution without a central directory |
| Ciphertext envelope format | Pairing/invite → `pear://` links / topics / keys; name→key mapping is app-owned |

## Open problems the spike must solve (not solved by "just use Pears")

- **Prekey distribution without a directory** — X3DH needs a peer's prekey bundle when they
  are offline; in P2P that means DHT-published signed bundles or on-node hosting.
- **Group membership over a multi-writer log** — Autobase is a genuinely stronger substrate
  than relay-ordered state (verifiable, multi-writer via `addWriter`), but it is
  *eventually-consistent* and needs a deterministic `apply` + indexer/quorum liveness. A
  better data structure, not a free authority.
- **Availability liveness** — with no blind peer running and all human peers offline, a
  group is dark until someone comes back. Acceptable for local-first; the self-hosted node
  is the answer for people who want always-on.

## Consequences

- **Positive:** removes the central operator and its metadata visibility; makes the
  always-on component optional and self-hostable; unifies AI hosting and offline mailboxing
  into one self-hosted-node concept; keeps the entire crypto core and product surface.
- **Negative / cost:** a real transport-layer rebuild (prekeys, membership, availability);
  eventual consistency replaces relay-ordered simplicity; "AI always in the loop" becomes a
  paid-by-self-hosting property rather than a default.
- **Honest scope:** this ADR records a **direction**, not a shipped capability. Until the
  spike lands, the accurate public statement is: *"signal-ai runs on a ciphertext-only
  hosted relay today; a no-central-operator P2P transport is the roadmap end-state."* Do
  **not** claim serverless/P2P as a current property.
