# Plan 005 (follow-up) — `listMembers` should fail-closed when the membership fold is unavailable

**Status:** OPEN (hardening follow-up; non-blocking).
**Written against commit:** `fe9a33e` (branch `invitepin-tofu-sdk-wiring`).
**Surfaced by:** the independent Verifier pass on the InvitePin TOFU SDK wiring (Task #15).
**Severity:** low — hardening, not an active exploit. Trigger requires a client-usage
anti-pattern; the weak fallback it exposes is **pre-existing**, not introduced by the
InvitePin wiring.

## Context

Plan 004 made the signed op-log the live membership authority; the InvitePin wiring
(commit `fe9a33e`) then made `membershipLogFor` **pin-aware and fail-closed-uniform** —
it returns `undefined` on *any* build failure (`MembershipLog.open` corruption **and**
`forJoiner` pin-mismatch), and the receive-path gate (`enforceInbound`) correctly drops
inbound messages when the fold is `undefined`.

`listMembers` does **not** share that fail-closed posture. It retains an older
"no fold → raw relay roster" fallback: whenever `membershipLogFor(conversationId)` is
`undefined`, `listMembers` falls back to the **untrusted relay-served roster** instead of
refusing.

## The defect

If a pin is seeded via `acceptInvitePin(...)` **after** an unpinned chain was already
adopted for the same `conversationId`, the next `membershipLogFor` call re-validates the
persisted chain against the (now-present) pin from scratch. On mismatch it returns
`undefined`. That fail-closes the **message gate** (good), but `listMembers` then falls
through to the raw relay roster — so a caller reading the roster in that window trusts
relay-authoritative membership data the gate has just rejected. The two surfaces
disagree: the gate says "no trusted chain," the roster says "here's what the relay
claims."

- Trigger: retroactive pin add (an API-usage anti-pattern — normal flow seeds the pin
  *before* first drain).
- Blast radius: roster **display/enumeration** only; the enforcement gate is unaffected
  and still drops non-member traffic.

## Proposed fix (pick one, decide in review)

1. **Make `listMembers` fail-closed** — when `membershipLogFor` is `undefined`, return an
   empty set / explicit "roster unavailable (no trusted chain)" signal rather than the
   raw relay roster. Mirrors the receive-path gate's posture. **Preferred.**
2. **Refuse retroactive pins** — `acceptInvitePin` throws (or no-ops with a warning) if a
   chain is already adopted for that `conversationId`, eliminating the trigger. Cheaper
   but narrower; leaves the underlying "no fold → raw roster" fallback in place for other
   `undefined` causes.

Option 1 addresses the class (any `undefined` fold → no relay-trust leak); option 2 only
closes this one trigger. Recommend **1**, optionally **1 + 2**.

## Verification (falsifiable)

- `V-1` after a forced `membershipLogFor === undefined` (corrupt chain OR pin-mismatch),
  `listMembers(convId)` does **not** return relay-sourced members — it returns empty /
  an explicit unavailable signal. New client-sdk test alongside the D-1/D-2 pattern in
  `packages/client-sdk/test/membership-gate.test.ts`.
- `V-2` existing behavior preserved: with a healthy adopted chain, `listMembers` still
  equals `MembershipLog.members()` (no regression to B-*/C-* / D-1).
- `V-3` `pnpm -r run typecheck && pnpm -r run lint && pnpm -r run test` EXIT 0.

## Scope guard

Same as all plans: do NOT touch `packages/core` crypto, the ciphertext `EnvelopeSchema`,
`apps/cli`/TUI, or `/verify`. This is a client-sdk `listMembers` change (+ optional
`acceptInvitePin` guard) and one test only. Does not affect the deferred/human-gated
Phase D relay-authority deletion.
