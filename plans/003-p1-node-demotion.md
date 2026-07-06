# Plan 003 — P1: `apps/relay` → `apps/node` demotion (ciphertext MailboxService only)

- **Phase:** P1 (design §D). **Depends on:** **001** (the membership/authority code must be isolated behind the split before it can be deleted). **Blocks:** nothing hard; pairs with 004.
- **Written against commit:** `6cf9e1a`.
- **Design source:** [`docs/design/p2p-transport.md`](../docs/design/p2p-transport.md) §B.3 (thin node = MailboxService + agent-as-client), §D Phase P1, §F.6.
- **§F items:** **F.6 *prepared*, not completed.** P1 extracts the ciphertext-only `MailboxService` and **fences** (does not delete) the membership/authority handlers, plus enforces the agent-as-client module boundary (the decidable half of F.6). The full "blind peer, holds ciphertext only, zero membership authority" claim is a **Plan 004 postcondition** — it holds only after the op-log is authoritative (§F.2/§F.3/§F.4 tests green + Linus). A fenced-but-live authority handler is **still authority**; do not describe the P1 node as a blind peer, in code comments, release notes, or the README, until Plan 004 deletes that path.
- **Effort:** L. **Risk of the change:** MEDIUM-HIGH — this is the demotion that *removes* central authority. Deletions of authority code are the point, but must be staged so the current relay keeps working until P2P + membership land.

## Why this exists

The north star (ADR 0001, memory `signal-ai-p2p-direction`) is **no central operator**.
Today `apps/relay` is the operator: it queues messages *and* it is the source of truth for
group membership (`listMembers` reads authority from it — see `client.ts:505-517`). P1
restructures it toward `apps/node`: it will *become* a **blind peer** (design §B.1) that
stores and forwards **ciphertext only**, but P1 gets it only **part-way there**. P1 extracts a
`MailboxService` (store ciphertext for offline peers, forward on reconnect, never inspect or
decide) **and fences** the membership/authority handlers behind `// AUTHORITY — removed in P2`
markers — it does **not** delete them, because until the signed op-log (Plan 004) is
authoritative the relay is still the only source of membership truth (`listMembers` reads it —
`client.ts:505-517`). So after P1 the node **still contains live authority code**; it is not
yet a blind peer. Membership authority is *removed* (handlers deleted) only as a Plan 004
postcondition; connectivity moves to P2P in Plan 002. Design §B.3 also folds "AI host" and
"mailbox" into the *same* self-hosted node (memory synthesis) — so the node runs the
agent-as-a-client, it is not privileged.

**Critical sequencing:** per user directive, Dustin tests the **P2P** build, not the relay —
so the relay's demotion is real, not cosmetic. But per reviewers, the relay must keep
functioning until P2P (002) + membership (004) can replace it. So P1 **adds** the
ciphertext-only `MailboxService` role and **fences off** authority code for deletion; the
actual go-live cutover (and whether authority code is deleted vs. feature-flagged off) is a
decision for the /supergoal plan-review gate, not this plan.

## Current state (relay authority + mailbox surfaces — confirm at execution time)

> I did NOT re-read `apps/relay/src/index.ts` line-by-line this session; the design doc's
> coupling map cites the mailbox/drain path (~`:430-504`) and the membership/authority path
> (~`:179-190`, `:263-314`, `:535-542`). **Step 1 is to re-read and confirm these before
> editing** — line numbers are leads, not facts (improve Hard Rule).

Known from Plan 001 / `client.ts`: membership authority is expressed relay-side as the
backing for `createConversation`/`invite`/`removeMember`/`setAiMode`/`listMembers`. The
mailbox/drain path is what `DuplexLink`'s drain capability (001) talks to. The demotion
keeps the latter (as ciphertext-only) and strips the former.

## Scope

**In scope:**
- Create `apps/node` (or rename `apps/relay` → `apps/node`; decide by what preserves git
  history best — prefer `git mv`).
- Extract a `MailboxService`: accept ciphertext envelopes for an offline recipient pubkey,
  store, forward on reconnect. **Ciphertext only** — it must not parse `EnvelopeSchema`
  bodies, must not read membership, must not log plaintext (honor the existing
  `DEBUG_PLAINTEXT` gate; never log bodies/keys at info).
- Fence the membership/authority handlers behind a clearly-marked boundary so Plan 004 can
  remove them once the op-log is authoritative. Mark each with a `// AUTHORITY — removed in
  P2 (Plan 004); do not extend` comment.
- Host the agent **as a client** of the node, not as a privileged component (design §B.3,
  §F.6) — if agent wiring lives in the relay today, move it to the client side.

**Out of scope (DO NOT TOUCH):**
- `packages/core` crypto, `EnvelopeSchema`, `apps/cli`/TUI, `/verify`.
- Deleting authority code outright *in this plan* — fence it, don't delete it (deletion is
  Plan 004's job, after the op-log is authoritative, gated by Linus per design §D P2).
- **Do NOT modify 5A relay source beyond additive changes** (standing constraint) — the
  demotion is a new `apps/node` shell + extraction; avoid rewriting relay internals in place
  where an additive extraction works.

## Steps

1. **Drift check** (`6cf9e1a`) + **re-read** `apps/relay/src/index.ts` mailbox/drain and
   membership/authority sections; confirm the coupling-map line refs. Record the real line
   numbers you find.
2. Establish `apps/node` (prefer `git mv apps/relay apps/node` to keep history; update
   workspace refs, package name, scripts).
3. Extract `MailboxService` (ciphertext store-and-forward). Assert no plaintext/ membership
   access; keep the `DEBUG_PLAINTEXT` gate.
4. Fence every membership/authority handler with the `// AUTHORITY — removed in P2` marker.
   Do not change their behavior yet (the current relay must still work).
5. Move agent hosting to agent-as-client if it currently sits privileged in the relay.
6. Update the node's README/threat-model copy to state plainly: "ciphertext-only mailbox, no
   membership authority" (honesty-in-copy constraint; do not claim serverless before P2P
   go-live).
7. Verify.

## Verification

```bash
pnpm -r run typecheck && pnpm -r run lint && pnpm -r run test   # all green
pnpm --filter @signalai/node run test
grep -rn "AUTHORITY — removed in P2" apps/node/src   # every authority handler fenced
```
Done = `apps/node` builds and its `MailboxService` stores/forwards ciphertext for an offline
peer in a test; authority handlers are all fenced with the marker; no plaintext or membership
field is read in the mailbox path (assert by inspection + a test that feeds it an opaque blob
and confirms it round-trips without decode).

## Test plan

- `MailboxService`: store an envelope for offline recipient R, then on R's reconnect assert
  exact-once forward (mirror the relay's existing per-seq ack test if one exists —
  `signal-ai-client-sdk-delivery` memory notes a per-seq exact-ack invariant; preserve it).
- A test that passes a random opaque byte blob (not a valid `EnvelopeSchema`) through the
  mailbox and asserts it forwards unchanged — proves ciphertext-opacity.

## Maintenance note

The moment anyone adds a "just check membership here for convenience" read to
`MailboxService`, the node stops being a blind peer and the no-central-operator claim
(§F.6, ADR 0001) breaks. The `AUTHORITY` markers are the tripwire — review any change that
touches them. Also update ADR 0001's consequences with the §F.7 IP-exposure tradeoff (a node
that forwards for you sees your IP) as part of this phase's doc work.

## Escape hatches

- If `git mv` would break too many workspace refs to fix cleanly in one pass → create
  `apps/node` fresh, re-export from `apps/relay` as a shim, and report the deferred cleanup;
  don't leave the tree un-buildable.
- If membership authority turns out **not** cleanly separable from the mailbox path (they
  share state) → STOP and report; that coupling is exactly what Plan 004 needs to know, and
  forcing a split blind risks a behavior change to the still-live relay.
- If any change would delete authority code before Plan 004's op-log is authoritative →
  STOP; that ordering inversion breaks the "relay works until replaced" guarantee.
