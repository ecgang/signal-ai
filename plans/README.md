# P2P Transport Migration — Plan Index

Executable plans implementing [`docs/design/p2p-transport.md`](../docs/design/p2p-transport.md)
(reviewed + hardened by Liotta / Linus / Neo). Each plan is self-contained: an executor
with **zero context from the design session** can run it. Read the design doc §F (threat
model) once for the invariants these plans protect — but every plan re-states what it needs.

- **Written against commit:** `6cf9e1a`
- **Repo:** pnpm monorepo, Node ≥20, TypeScript ~5.5.4 (strict), vitest 2.0.5.
- **Verification (root):** `pnpm -r run typecheck && pnpm -r run lint && pnpm -r run test`
  (per-package: `pnpm --filter <name> run test`).
- **Scope guard (applies to ALL plans):** do NOT modify libsignal crypto in
  `packages/core` beyond the single additive test in Plan 001, the ciphertext
  `EnvelopeSchema` in `packages/proto`, `apps/cli`/TUI, or the `/verify` trust surface.
  These are AGNOSTIC in the design and must survive the migration untouched.

## Execution order & dependency graph

```
001 (P-1: interface split, on the CURRENT relay)   ← keystone, do FIRST
      │  no behavior change; unblocks everything
      ├─────────────► 002 (P0: packages/p2p + transport-p2p.ts)
      │                     │ needs MessageTransport to exist
      │                     ▼
      └─────────────► 003 (P1: apps/relay → apps/node demotion + MailboxService)
                            │ needs the split so authority code is isolated to delete
                            ▼
                      004 (P2: packages/membership signed op-log + enforcement)
                            needs MembershipService seam (001) + a transport to fan out (002)
```

**Hard rule:** 001 lands and is green before any other plan starts. Neo's blocking
finding is that without the interface split, P0 can only ship by stubbing five
nonsensical membership methods → big-bang cutover. 001 is what makes this incremental.

## Status

| # | Plan | Phase | Depends on | §F items | Status |
|---|------|-------|-----------|----------|--------|
| 001 | Interface split: `Transport`→`MessageTransport`+`DirectoryService`+`AccountService`+`MembershipService`, `WsLink`→`DuplexLink`, no-shared-sender-key test | P-1 | — | F.1 | TODO |
| 002 | `packages/p2p` hyperswarm wrapper + `transport-p2p.ts` (2nd `MessageTransport`) + acceptance check: implements message plane WITHOUT stubbing account/directory/membership | P0 | 001 | — | TODO |
| 003 | `apps/relay`→`apps/node` demotion: ciphertext `MailboxService` only, **extract + FENCE authority code (do NOT delete)** | P1 | 001 | F.6 | TODO |
| 004 | `packages/membership` signed op-log: receiver-side enforcement + genesis re-send **+ authenticated log-head metadata (proto) + latestness/head mechanism**; deletion of relay authority is a 004 postcondition | P2 | 001, 002 | F.2, F.3, F.4 | TODO |
| 005 | Follow-up (hardening): make `listMembers` fail-closed when the membership fold is `undefined` instead of falling back to the raw relay roster (surfaced by the InvitePin-TOFU Verifier pass) | P2-followup | 004 | F.3 | OPEN |

> **Authority-deletion ordering (do not violate — Codex critical #4):** Plan 003 **only
> extracts and fences** the relay's membership/authority handlers (marks them
> `// AUTHORITY — removed in P2`). Actual deletion of relay authority happens **only as a
> postcondition of Plan 004**, gated on its §F.2/§F.3/§F.4 tests passing *and* Linus review.
> An executor must never remove relay membership authority in P1 — doing so leaves the system
> with no authority and no authoritative op-log, exactly the gap the phasing exists to prevent.

## Not covered by these plans (deferred / out of scope)

- **P3 hardening** (design §D): DHT mutable-record bundle refresh, node-hosted OTK vending,
  petname UX. Depends on 002–004 landing first; §F.5 (OTK-reuse / downgrade oracle) is
  resolved there, not here.
- **NAT-traversal reality check** (design Risk 1): P0 (Plan 002) exists to *find* whether
  Eric↔Dustin hole-punch works; if symmetric-NAT bites, `relayThrough` fallback is a
  follow-up not specified here.
- **libsignal signed-prekey-only X3DH** (design open-Q#1): must be answered by code
  inspection before P0's offline-first-contact path; flagged inside Plan 002 as an escape hatch.
- **ADR 0001 IP-exposure consequence** (§F.7): a one-paragraph doc edit, tracked in the
  design doc, not a code plan.

## Considered and rejected

- **Adopt Autobase/Hypercore as the v1 data model** — rejected in design §A: the Double
  Ratchet already provides ordering/authentication/tamper-evidence; layering a replicated
  log under opaque ciphertext is redundant machinery with an eventual-consistency bug class.
  Revisit only if groups grow to hundreds of churning writers.
- **nostr as primary transport** — rejected (design §A): reintroduces third-party relay
  operators seeing metadata. Kept as a documented fallback only.
