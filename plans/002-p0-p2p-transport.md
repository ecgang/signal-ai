# Plan 002 — P0: `packages/p2p` hyperswarm wrapper + `transport-p2p.ts`

- **Phase:** P0 (design §D). **Depends on:** **001** (needs `MessageTransport` to exist as a seam). **Blocks:** 004 (needs a P2P fan-out path).
- **Written against commit:** `6cf9e1a`.
- **Design source:** [`docs/design/p2p-transport.md`](../docs/design/p2p-transport.md) §B.1 (connectivity), §D Phase P0, Risk 1 (NAT), Risk 4 / §F.7 (IP exposure).
- **§F items satisfied:** none *closed* here (this is the connectivity spike). It creates the substrate 004 uses; §F.5 (OTK reuse/downgrade) is P3, not here.
- **Effort:** L. **Risk of the change:** MEDIUM — new dependency + real-network behavior (NAT). Purely additive: it does not remove or alter the relay path.

## Why this exists

P0 answers the one question the whole P2P direction rests on and cannot be answered by
design: **can Eric's box and Dustin's box actually hole-punch a direct encrypted channel
over the open internet?** It builds a *second* `MessageTransport` implementation
(hyperswarm/HyperDHT under the hood) alongside the existing relay one from Plan 001, and a
manual harness to send ciphertext between two peers addressed by public key. Membership,
mailbox, and AI are explicitly **not** in P0 — this is connectivity only.

The subtraction thesis (design §A): P2P is the relay's `send`/socket methods
re-implemented over a different pipe, **not** a distributed database. The Double Ratchet
already gives ordering/auth/tamper-evidence, so P0 carries opaque `EnvelopeSchema`
ciphertext byte-for-byte — it does not parse or re-order it.

## Current state (from Plan 001's output — confirm at execution time)

- After 001, `Transport` is split into four role interfaces. The **only** one this plan
  reimplements is **`MessageTransport`** — the message-delivery plane, which is essentially
  `openSocket()` (there is no REST `send`; messages/deliveries ride the WebSocket via
  `ClientSocket.send`). The account (`signup`), directory (`publishDevice`/`fetchBundles`/
  `fetchBundlesByUserId`), and membership (`createConversation`/…/`listMembers`) planes are
  **out of scope for P0** and must NOT be stubbed on the P2P transport (see acceptance check).
- `DuplexLink` (in `connection.ts`) carries the explicit **drain capability** — the P2P
  transport must satisfy this by providing its own replay-on-connect, since there is no
  server-side inbox to drain.
- `EnvelopeSchema` in `packages/proto` is the ciphertext wire type — **treat as opaque**.

## Scope

**In scope (create):**
- New package `packages/p2p` — a thin wrapper over `hyperswarm`/`hyperdht`: `join(topic)`,
  `connectByPubKey(pubkey)`, duplex stream per peer, `relayThrough` NAT fallback exposed as
  config. No app logic; no ciphertext parsing.
- `packages/client-sdk/src/transport-p2p.ts` — a second `MessageTransport` impl backed by
  `packages/p2p`, satisfying `DuplexLink`'s drain capability with a local replay buffer.
- A manual two-peer harness (script or test) proving A↔B ciphertext delivery by pubkey.

**Out of scope (DO NOT TOUCH):**
- The relay impl, `EnvelopeSchema`, `packages/core` crypto, `apps/cli`/TUI, `/verify`.
- Membership (Plan 004), mailbox/offline (Plan 003), AI (later).
- Prekey **directory** semantics — P0 may hardcode/side-channel the peer pubkey for the
  spike; DHT-published signed bundles are P3.

## Steps

1. **Drift check** (`6cf9e1a`); confirm 001 landed (grep for `MessageTransport` in
   `transport.ts`). If 001 not present → STOP.
2. Scaffold `packages/p2p` matching the monorepo's package conventions (copy an existing
   `packages/*/package.json` + `tsconfig` as the exemplar — AGPL-3.0-only, Node ≥20, TS
   strict). Add `hyperswarm`/`hyperdht` deps (`pnpm --filter @signalai/p2p add ...`).
3. Implement the wrapper: topic join, connect-by-pubkey, per-peer duplex, `relayThrough`
   config knob. Keep it dumb — bytes in, bytes out.
4. Implement `transport-p2p.ts` as a `MessageTransport` over the wrapper; implement the
   drain capability with a client-side replay buffer (no relay inbox exists).
5. Write the two-peer harness (see Test plan) and run it locally on two processes.
6. **Record the NAT reality** (design Risk 1): document in the harness output whether direct
   hole-punch worked or `relayThrough` fallback was needed. This is P0's actual deliverable.
7. Verify (below).

## Verification

```bash
pnpm -r run typecheck && pnpm -r run lint && pnpm -r run test   # all green
pnpm --filter @signalai/p2p run test
# manual: run the two-peer harness in two terminals; assert B receives A's ciphertext
```
Done = the harness moves an `EnvelopeSchema` ciphertext A→B by pubkey with no relay in the
loop, AND the NAT-traversal outcome is recorded. The relay path must still pass all its
existing tests (P0 is additive).

**Evidence / notes (recorded at P0 execution):**
- not-exercisable-in-sandbox: real-internet hole-punch untestable (no outbound public DHT); dial-by-pubkey + opaque-byte delivery PROVEN offline via in-process @hyperswarm/testnet

**Real-NAT probe (2026-07-06 — the step-6 deliverable, out-of-sandbox):**
`packages/p2p/scripts/probe.ts` runs the real listen→dial→echo path against the
**public mainnet DHT** (no injected bootstrap) — the one thing the offline test can't do.
Its binary path is smoke-verified end-to-end over a local testnet bootstrap (deterministic
seed → stable pubkey; 512 opaque bytes round-tripped; `SUCCESS` + exit 0). Run it on two
machines on **different networks** (not the same LAN) to record the NAT verdict:

```bash
# Machine A (Eric):
node_modules/.bin/tsx packages/p2p/scripts/probe.ts listen --seed <hex64>
#   → prints LISTENING_PUBKEY: <hex64>   (send out-of-band to Dustin)
# Machine B (Dustin):
node_modules/.bin/tsx packages/p2p/scripts/probe.ts dial <pubkey-hex64>
#   → SUCCESS (exit 0) = direct hole-punch works | FAIL (exit 1) = retry with --relay <peer>
```

| Date | A network | B network | direct? | relayThrough needed? | handshake / echo ms | verdict |
|------|-----------|-----------|---------|----------------------|---------------------|---------|
| TODO | | | | | | run Eric↔Dustin |

A `FAIL` is a valid, valuable result: it means symmetric NAT bites → build the `relayThrough`
auto-fallback (stubbed at `client-sdk/src/transport-p2p.ts`) **before** wiring P2P into any app.

**Acceptance check (Codex-added — validates Plan 001's seam):** `transport-p2p.ts` must
type-check and function implementing **`MessageTransport` alone** — with **no stub, throw, or
no-op implementation of `AccountService`, `DirectoryService`, or `MembershipService`**. Assert
this: `grep`-check that `transport-p2p.ts` neither imports nor implements those three
interfaces. If P0 finds it *can't* work without them (e.g. it needs directory lookup to place
a call), that means Plan 001's split boundary is wrong → STOP and report; do not paper over it
with stubs (that reintroduces the big-bang cutover the split exists to prevent).

## Test plan

- `packages/p2p`: unit-test the wrapper against an in-memory/loopback DHT if the library
  supports it; otherwise a localhost two-peer integration test.
- `transport-p2p.ts`: a test asserting it satisfies the same `MessageTransport` contract the
  relay impl does (send/receive opaque bytes), and that its drain replay redelivers buffered
  ciphertext on reconnect.

## Maintenance note

`packages/p2p` is where the "always-on box doesn't vanish, it becomes optional" reality
lives (design §B.1, memory `signal-ai-p2p-direction`). Anyone tempted to add message
ordering, dedup, or a replicated log **here** is re-inventing what the Double Ratchet
already does — push back (design §A rejects Autobase as the v1 data model).

## Escape hatches

- **libsignal offline first-contact (design open-Q#1):** if establishing a session P2P
  requires an X3DH one-time-prekey the peer can't serve while offline, and signed-prekey-only
  X3DH turns out unsupported by `@signalapp/libsignal-client@0.96.4` → STOP and report. The
  offline-first-contact path may need the node mailbox (Plan 003) to vend prekeys first; do
  not invent a crypto workaround.
- If symmetric-NAT makes direct hole-punch fail for the Eric↔Dustin pair even with
  `relayThrough` → STOP, record it as the P0 finding, and surface it to the /supergoal gate;
  do not silently ship a broken transport.
- If satisfying `MessageTransport` requires changing the interface shape from Plan 001 →
  STOP; the seam is supposed to already fit. Report the mismatch (it means 001's boundary
  was wrong).
