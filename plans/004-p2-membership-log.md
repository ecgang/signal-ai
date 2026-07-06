# Plan 004 — P2: `packages/membership` signed op-log + receiver-side enforcement + genesis re-send

- **Phase:** P2 (design §D). **Depends on:** **001** (the `MembershipService` seam it replaces), **002** (a transport to fan the log out over). Pairs with **003** (deletes the fenced authority code once this is authoritative).
- **Written against commit:** `6cf9e1a`.
- **Design source:** [`docs/design/p2p-transport.md`](../docs/design/p2p-transport.md) §B.2 (membership + op-log integrity), §C (membership deps core+proto, never reverse), §D Phase P2, §F.2, §F.3, §F.4.
- **§F items satisfied:** **F.2** (removal-enforcement holes: receiver-side enforcement — a removed member's messages are rejected by *receivers*, not just un-sent — malicious-member continued-send, propagation race), **F.3** (op-log integrity: genesis bootstrap + truncation/withholding), **F.4** (founder key loss/compromise — v1 accept + document).
- **§F numbering note:** these map to the design doc's authoritative §F table (p2p-transport.md:202-208). Receiver-side enforcement is **F.2**, NOT F.3; genesis+truncation is **F.3**. Any test/verifier must cite these numbers to match the design.
- **Effort:** L (highest-judgment plan). **Risk of the change:** HIGH — this is where "removed ⇒ can't participate" becomes cryptographically real instead of relay-enforced. **Linus gates this phase** (design §D P2). Security-sensitive path → prefer Linus pre-implementation on the op-log design before coding.

## Why this exists

Today membership is whatever the relay says (`client.ts:505-517` reads it from the relay
every refresh). With no central operator, there is no relay to ask — so membership must
become a **signed, replicated operation log** that every peer can independently verify:
`create`, `invite`, `remove`, `setAiMode` are signed ops chained by hash; each peer applies
them deterministically to compute the current member set. Design §B.2 breaks this into the
hard sub-problems, and §F.1's *strictly-pairwise* fan-out (locked by Plan 001's test) means
this log governs **who you send to** and **whose messages you accept** — there is no
sender-key epoch to rotate, which is what makes removal tractable.

The two invariants that carry the whole product differentiator:
- **§F.2 receiver-side enforcement** — the load-bearing abuse case. A removed member (or a
  malicious peer) can still *emit* ciphertext; correctness requires every *receiver* to
  reject messages from a sender the log says was removed as of that point. Un-sending is not
  enough. **This is the negative criterion the /goal verifier weights most.**
- **§F.3 op-log integrity** — genesis bootstrap (how a joiner trusts the first op) and
  truncation/withholding resistance (a peer can't hide later `remove` ops by serving a valid
  prefix). Founder-key-loss is **§F.4** (v1 accepts + documents "lose the founder key ⇒ group
  bricks; no succession").

## Prerequisites — resolve BEFORE writing any op-log code (Codex critical #1, #2)

The adversarial review surfaced two gaps that make the naive version of this plan unsound.
Both must be resolved *as design decisions with proto changes + tests* before the op-log is
coded — they are not escape hatches, they are entry conditions.

### PREREQ-1 — Authenticated log-position metadata on messages (unblocks §F.2)
Receiver-side enforcement asks "was this sender a member as of the log position this message
references?" — but the current wire carries **no such reference**. Confirmed by reading
`packages/proto/src/index.ts`: `EnvelopeSchema` holds only conversationId, sender ids,
recipientDeviceId, seq, ciphertext, type; `PlaintextMessageSchema` has no membership-log
head/seq/hash. So:
- Add an **authenticated** membership-head reference (log seq **and** head hash) to the
  message. It MUST live inside `PlaintextMessageSchema` (the ratchet-encrypted, end-to-end
  authenticated payload) — NOT in the cleartext `EnvelopeSchema` envelope, which a node/relay
  can see and an attacker could forge. Riding inside the ratchet ciphertext means the head
  reference inherits libsignal's sender authentication for free (invent no crypto).
- Old clients that don't send the field must **fail closed** (receiver rejects, does not
  default-accept).
- This is a **proto change with its own tests**, landed before the enforcement code.

### PREREQ-2 — A latestness / current-head mechanism (unblocks §F.3 truncation)
Signatures + hash-chain prove a log is *internally valid*; they do **not** prove it is
*latest*. A malicious peer can serve a valid **prefix** that omits a later `remove`, and a
joiner/stale receiver folds it and accepts messages from an already-removed member — breaking
§F.2 receiver-side enforcement. Design §A rejects quorum/Autobase, so the mechanism must be
lightweight, NOT consensus:
- **Pinned head in the invite** — the invite (out-of-band, like a Signal safety number)
  carries the genesis hash *and* the head hash at invite time, so a joiner has a trusted lower
  bound it cannot be rewound below (trust-on-first-use).
- **Monotonic signed head gossip** — peers advertise their highest validly-signed
  `(seq, headHash)`; a receiver **never regresses** below the highest authenticated head it
  has ever seen. A prefix that's behind that head is rejected without needing consensus.
- **Head reference on messages** (PREREQ-1) lets a lazy receiver detect it's behind and catch
  up before accepting.
- If, after specifying this, latestness still can't be guaranteed for a peer with **no prior
  local knowledge and a hostile sole source**, then the honest fallback (design §F.3 / Codex
  rec) is: **downgrade the truncation claim to an accepted stale-prefix risk AND block
  deletion of relay authority** — i.e. Plan 003's relay stays authoritative until this is
  genuinely solved. Do not claim truncation-resistance the mechanism can't deliver.

Both prereqs go to **Linus pre-implementation review** with the op-log design (Step 2).

## Current state (confirm at execution time)

- After 001, `MembershipService` is the seam this replaces (the five conversation methods).
  The relay impl stays as a fallback until this log is authoritative; then Plan 003's fenced
  `// AUTHORITY — removed in P2` handlers get deleted.
- `packages/core` provides the signing/identity primitives (libsignal); `packages/proto`
  provides wire schemas. **Dependency direction lock (Neo, design §C):** `packages/membership`
  may depend on `core` + `proto`, **never** the reverse; `group.ts` already takes the recipient
  set as a *parameter* (`encryptForMembers(pt, memberDeviceAddresses, ctx)` — group.ts:53), so
  membership computes the set and hands it in. Do not make `core` import `membership`.
- **Invent no crypto** — signatures/hash-chain use libsignal + a standard hash already in the
  tree; do not design a novel scheme.

## Scope

**In scope (create/change):**
- **`packages/proto`:** add the authenticated membership-head reference `(seq, headHash)` to
  `PlaintextMessageSchema` (PREREQ-1), with its own schema tests. This is the one sanctioned
  proto change — additive, inside the ratchet-encrypted payload, fail-closed for old clients.
- `packages/membership`: signed op types (`create`/`invite`/`remove`/`setAiMode`), hash-chain
  linkage, deterministic `apply(log) → memberSet`, signature verification against member
  identity keys, genesis handling, and the PREREQ-2 latestness mechanism (pinned invite head +
  monotonic signed head gossip, non-regression rule).
- A `MembershipService` impl over the log (satisfying Plan 001's seam) that fans ops out via
  a `MessageTransport` (Plan 002) — no relay authority.
- **Receiver-side gate**: a check every peer runs on inbound messages — "was this sender a
  member as of the log head this message references (PREREQ-1), and is that head not behind my
  non-regressing known head (PREREQ-2)?" Reject if not (§F.2).
- Genesis re-send: when a new member joins, the existing members re-send the log from genesis
  so the joiner can verify the chain against the invite-pinned head (§F.3 bootstrap).

**Out of scope (DO NOT TOUCH):**
- Novel crypto, `packages/core` internals, the **cleartext `EnvelopeSchema` envelope** body
  semantics (the head reference goes in `PlaintextMessageSchema`, not the envelope),
  `apps/cli`/TUI, `/verify`.
- Making `core`/`proto` depend on `membership` (direction lock — `proto` only gains a passive
  schema field; it must not import `membership`).
- Deleting Plan 003's fenced authority handlers is a *follow-on* once tests prove the log
  authoritative — do it in the same PR only if Linus's gate passes.

## Steps

1. **Drift check** (`6cf9e1a`); confirm 001 (`MembershipService` seam) and 002
   (`MessageTransport`, `transport-p2p.ts`) landed. If not → STOP.
2. **Design the op-log + get Linus pre-impl review on the design** (security-sensitive path;
   design §D P2 gates here). Write the op schema, chain rule, `apply` determinism rule, and
   the integrity answers (genesis trust + truncation resistance = §F.3; founder-key-loss =
   §F.4) as a short design note first; do not code until the design answers all three.
3. Scaffold `packages/membership` (deps: `core`, `proto` only). Implement signed ops +
   hash-chain + deterministic `apply`.
4. Implement the `MembershipService` impl over the log; fan ops via `MessageTransport`.
   `group.ts` still receives the computed member set as a param — do not change `group.ts`.
5. Implement **receiver-side enforcement** and **propagation-race handling** (both §F.2:
   define the tie-break when a `remove` and a message from the removed peer cross in flight —
   the message referencing a log head at/after the `remove` is rejected).
6. Implement genesis re-send on join (§F.3).
7. Verify + Linus gate. If green and Linus `CONVERGED`, delete Plan 003's fenced authority
   handlers in the same change; otherwise leave them and report.

## Verification

```bash
pnpm -r run typecheck && pnpm -r run lint && pnpm -r run test
pnpm --filter @signalai/membership run test
```
Done requires tests proving, at minimum:
- **§F.2 (negative, load-bearing):** peer C is removed at log head N; a message C emits
  referencing a head ≥N is **rejected by an independent receiver** — assert the receiver drops
  it, not merely that the sender didn't include C. Also assert a message carrying **no** head
  reference (old-client shape) is rejected (fail-closed, PREREQ-1).
- **§F.3 truncation (via PREREQ-2, not hash-chain alone):** a peer serving a valid log
  *prefix* that hides a later `remove` is rejected by a receiver whose non-regressing known
  head is already past that prefix, AND by a fresh joiner whose invite pinned a head past it.
  The test must construct an *internally-valid* prefix (correct signatures + hash links) —
  proving detection comes from the latestness mechanism, not from the prefix being malformed.
  If PREREQ-2 was downgraded to accepted-risk, this test instead asserts relay authority is
  NOT deleted (Plan 003 handlers still present).
- **§F.3 genesis:** a fresh joiner verifies the chain from genesis against the invite-pinned
  head and computes the same member set as existing peers.
- **§F.2 race:** simultaneous `remove(C)` + message-from-C resolves deterministically to
  reject C's message.
- **Direction lock:** `packages/core`/`packages/proto` have no import of `packages/membership`
  (`grep -rn "@signalai/membership" packages/core packages/proto` → empty).

## Test plan

Build a multi-peer in-memory harness (no network needed): three identities, apply a scripted
op sequence, assert every peer computes the identical member set, then drive each negative
case above. Mirror the existing `packages/core` test harness for identity/session setup. Each
test names the §F item it covers in its description so the /goal verifier maps test→criterion.

## Maintenance note

This is the file where the demo differentiator lives: "after removal, verifiably cannot
participate." Any future change that lets a receiver skip the membership gate for performance,
or that trusts a peer-supplied member set instead of re-deriving it from the verified log,
silently breaks §F.2 and must be rejected in review. The receiver-side gate is not optional
and not a fast-path candidate.

## Escape hatches

- If deterministic `apply` needs a total order the transport can't provide (concurrent ops
  from two admins) and resolving it requires a consensus/quorum mechanism → STOP and report;
  the design (§A) explicitly rejected Autobase/replicated-DB machinery for v1, so a
  quorum requirement is a design escalation for the /supergoal gate, not something to invent
  here.
- If founder-key-loss (§F.4) has no answer that doesn't reintroduce a privileged party →
  STOP and surface it; this is a known-hard problem the design flagged, and a wrong answer
  quietly restores a central operator.
- The message-metadata gap that used to block §F.2 is now **PREREQ-1** (add the authenticated
  head reference to `PlaintextMessageSchema`) — it is in-scope, not a stop condition. STOP only
  if that field cannot be authenticated inside the ratchet payload without a novel crypto
  construction (invent-no-crypto rule).
