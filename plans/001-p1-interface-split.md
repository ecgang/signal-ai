# Plan 001 — P-1: Interface split (no behavior change) + no-shared-sender-key test

- **Phase:** P-1 (design §D). **Depends on:** nothing. **Blocks:** 002, 003, 004.
- **Written against commit:** `6cf9e1a`.
- **Design source:** [`docs/design/p2p-transport.md`](../docs/design/p2p-transport.md) §C (Neo's 3 locks), §D (Phase P-1), §F.1.
- **§F items satisfied:** **F.1** (no shared sender-key / removal loses sender-side confidentiality — locked by a test).
- **Effort:** M. **Risk of the change:** LOW (pure refactor + additive test; zero behavior change is the whole point).

> **Revision note (post-Codex-review):** the first draft of this plan split `Transport`
> into two interfaces around a `send`/prekey message-plane. **That was wrong** — the live
> interface has no `send` method (messages ride the WebSocket), and it bundles *four*
> concerns, including an account/signup plane and a key-directory plane that are themselves
> central-authority surfaces. This revision splits along the real seam and adds a P0
> acceptance check so Plan 002 can't smuggle in a big-bang cutover.

## Why this exists (read before touching code)

The current client talks to the relay through ONE fat interface, `Transport`
(`packages/client-sdk/src/transport.ts:38-56`), that mixes **four** unrelated concerns:

1. **Message delivery** — `openSocket()`. There is *no* REST `send`; messages and
   deliveries flow over the WebSocket (`ClientSocket.send`, transport.ts:9-17). This is the
   only plane Plan 002's P2P transport must reimplement.
2. **Key directory** — `publishDevice`, `fetchBundles`, `fetchBundlesByUserId`. Publishing
   and looking up prekey bundles. A central-authority surface (in P2P this becomes
   DHT-published signed bundles — design open-Q#1, P3).
3. **Account** — `signup(inviteCode, username) → {userId, token}`. Pure central authority:
   invite codes, usernames, bearer tokens. In P2P the **public key is the identity**, so
   there is no signup at all.
4. **Membership** — `createConversation`, `invite`, `removeMember`, `setAiMode`,
   `listMembers`. In P2P this becomes the signed op-log (Plan 004).

The P2P work (Plan 002) needs a second way to move messages (hyperswarm) **without** a
second signup, directory, or membership authority — in P2P there is no relay to sign you up,
vend bundles, or adjudicate membership. Neo's blocking finding: if the interface isn't split
first, Plan 002 can only ship by stubbing the signup/directory/membership methods on the P2P
transport → a big-bang cutover instead of an incremental one. **Codex's sharpening:** the
split must isolate all three central-authority planes (account, directory, membership) from
the one plane P2P actually reimplements (message delivery), and a P0 acceptance check must
prove the P2P transport implements *only* the message plane without stubbing the others.

So P-1 splits the interface **on the current relay, with no behavior change**, and does
nothing else. When it lands, `pnpm -r run test` is still green and the app behaves
identically — we've only re-drawn internal seams. It also locks §F.1 (highest-severity
invariant) with a test while we're already in `packages/core`.

## Current state (verbatim excerpt I read at `6cf9e1a`)

### `packages/client-sdk/src/transport.ts:38-56` — the real fat interface

```ts
export interface Transport {
  // ── account plane (central authority; NO P2P equivalent — pubkey is identity) ──
  signup(req: { inviteCode: string; username: string }): Promise<{ userId: string; token: string }>;
  // ── directory / prekey plane (central authority; P2P → DHT-published signed bundles) ──
  publishDevice(token: string, userId: string, bundle: PreKeyBundlePublic): Promise<void>;
  fetchBundles(token: string, username: string, deviceId?: number): Promise<PreKeyBundlePublic[]>;
  fetchBundlesByUserId(token: string, userId: string, deviceId?: number): Promise<PreKeyBundlePublic[]>;
  // ── membership plane (central authority; P2P → signed op-log, Plan 004) ──
  createConversation(token: string, req: { creatorUserId: string; memberUserIds: string[]; aiMode: boolean }): Promise<string>;
  invite(token: string, conversationId: string, userId: string): Promise<void>;
  removeMember(token: string, conversationId: string, userId: string): Promise<void>;
  setAiMode(token: string, conversationId: string, enabled: boolean): Promise<void>;
  listMembers(token: string, conversationId: string): Promise<{ members: ConversationMember[]; aiMode: boolean }>;
  // ── message-delivery plane (the ONLY plane Plan 002 reimplements) ──
  openSocket(): ClientSocket;
}
```

`createHttpWsTransport(relayUrl)` (transport.ts:90-151) is the single concrete impl: REST
via `fetch` for the first nine methods, `openSocket()` returning
`wrapNodeSocket(new NodeWebSocket(new URL("/ws", wsBase)))` (transport.ts:147-149). Note the
`token` threaded through every REST method — it comes from `signup`, so the account plane is
a hard dependency of the directory and membership planes *on the relay*. That coupling is
relay-specific and must not leak into the message-plane seam.

### `packages/client-sdk/src/connection.ts` — `WsLink`, to gain a drain capability

`WsLink` (class at `:42`) owns the authenticated socket built from `openSocket()`: auth
first-frame `{type:"auth", token, deviceId}` (`:72`), `ready` handling that resets backoff +
starts keepalive + fires `onReady` (`:83-95`), `deliver` handling (`:97-100`), backoff
reconnect (`:124-131`), `send()` (`:147-150`), `subscribe()` (`:152-156`). Drain-on-ready is
already *documented* in the header comment (`:35-40`) but not named in the interface. Neo's
lock #3: rename the transport-facing seam to `DuplexLink` and give it an explicit **drain
capability**, so Plan 002's P2P transport (no server-side queue) provides its own replay
without the relay code assuming a relay-shaped inbox.

### `packages/client-sdk/src/client.ts` (~:440-540) — the membership + wire call sites

The client delegates membership mutations to the transport then re-reads via `listMembers`,
diffing the cache to emit `memberJoined`/`memberRemoved`; messages go over `WsLink`.
**Confirm the exact line numbers at execution time** (my earlier line refs proved unreliable
— see revision note). The architecturally-certain shape: membership calls delegate to the
membership methods above; the wire path uses `openSocket`/`WsLink`. Behavior must not change.

### `packages/core/src/group.ts` (whole file, 79 lines) — §F.1 is ALREADY TRUE in code

`GroupFanout.encryptForMembers(plaintext, memberDeviceAddresses, context)` (`:53-72`) loops
`await this.local.encrypt(member, plaintext)` — **one pairwise envelope per recipient from
the sender's own ratchet**. Docstring (`:20-35`): *"There is no group key or sender-key
ratchet… Removing a member is purely a caller-side decision to stop passing their address
into `encryptForMembers` — no key revocation step is needed."* This plan does not change
this — it **pins it with a test** so a future refactor can't silently introduce a shared
sender-key (which would break removal-loses-decryption).

## The split (the contract)

Split `Transport` into four role interfaces (names indicative — match repo casing):

| New interface | Methods | P2P fate (Plan 002/004) |
|---|---|---|
| `MessageTransport` | `openSocket()` (+ the `DuplexLink` drain capability) | **reimplemented** by `transport-p2p.ts` |
| `DirectoryService` | `publishDevice`, `fetchBundles`, `fetchBundlesByUserId` | DHT-published signed bundles (P3) |
| `AccountService` | `signup` | dropped — pubkey is identity |
| `MembershipService` | `createConversation`, `invite`, `removeMember`, `setAiMode`, `listMembers` | signed op-log (Plan 004) |

Keep `Transport = MessageTransport & DirectoryService & AccountService & MembershipService`
as a temporary alias so nothing downstream breaks in the same commit. `createHttpWsTransport`
returns an object satisfying all four (still one relay client, unchanged runtime).

## Scope

**In scope (edit):**
- `packages/client-sdk/src/transport.ts` — split into the four role interfaces + temp alias; one concrete factory unchanged.
- `packages/client-sdk/src/connection.ts` — `DuplexLink` seam + explicit drain capability (rename/extend, no behavior change).
- `packages/client-sdk/src/client.ts` — call sites consume the role interfaces; behavior identical.
- Barrel/index re-exports in `packages/client-sdk/src/` naming `Transport`/`WsLink`.
- `packages/core` test only — add `no-shared-sender-key.test.ts`; **do not edit `group.ts` source**.

**Out of scope (DO NOT TOUCH):**
- `packages/core/src/group.ts` source, any libsignal call, the ciphertext `EnvelopeSchema`/`PlaintextMessageSchema` in `packages/proto`.
- `apps/relay` source (P-1 is client-side only), `apps/cli`/TUI, `apps/agent`, `/verify`.
- Any *runtime* behavior: no new frames, no changed auth, no changed event order.

## Steps

1. **Drift check.** `git rev-parse --short HEAD` → expect `6cf9e1a`. Re-open the files above
   and confirm the excerpts still match. If `Transport` was already split → STOP and report.
2. **Split the interface** into `MessageTransport` / `DirectoryService` / `AccountService` /
   `MembershipService` + the temporary `Transport` intersection alias.
3. **Keep one concrete impl:** `createHttpWsTransport` returns an object satisfying all four
   (unchanged runtime). Optionally expose per-role factory *views* over the same client, but
   do not change any method's behavior.
4. **`connection.ts`:** introduce `DuplexLink` (the transport-facing subset of `WsLink`) and
   name the **drain capability** explicitly, reflecting the documented drain-on-ready
   (`:35-40`). `WsLink` still implements it against the relay exactly as today.
5. **`client.ts`:** point membership call sites at `MembershipService`, prekey/directory
   sites at `DirectoryService`, signup at `AccountService`, and the wire at
   `MessageTransport`/`DuplexLink` — same calls, same `listMembers`-after-mutate order, same
   emitted events.
6. **Add the §F.1 test** (see Test plan). Do not edit `group.ts`.
7. **Verify** (below).

## Verification (machine-checkable)

```bash
pnpm -r run typecheck    # expect: 0 errors
pnpm -r run lint         # expect: 0 new warnings vs baseline
pnpm -r run test         # expect: all pass UNMODIFIED, incl. the new §F.1 test
pnpm --filter @signalai/core run test
```

**P0 acceptance check (Codex-added — record it here, executed in Plan 002):** the split is
only correct if `transport-p2p.ts` can implement **`MessageTransport` alone** without
stubbing `AccountService`/`DirectoryService`/`MembershipService`. Plan 002 must assert this;
if it can't, the seam is wrong and this plan must be revised — do not let Plan 002 paper over
it with stubs.

Behavior-change guard (assert by inspection — no auto-diff exists): the set of wire frames,
auth handshake, and the order of `memberJoined`/`memberRemoved` emissions are unchanged. If
any existing test needed editing to stay green, that's a behavior change → STOP and report.

## Test plan — the §F.1 lock (load-bearing new artifact)

Mirror an existing `packages/core` `*.test.ts` harness/store setup. With recipients A, B and
sender S, assert:

1. `encryptForMembers(pt, [A, B])` yields **two distinct ciphertexts** (one per recipient),
   not one shared blob → per-recipient pairwise envelopes.
2. B decrypts **only** B's envelope; feeding B's session A's envelope fails → no shared
   sender-key exists that both could use.
3. After "removing" B (caller stops passing B to `encryptForMembers`), a later message has
   **no envelope decryptable by B's session** → removal-loses-**sender-side**-confidentiality
   as code.

If libsignal's API can't express assertion 2 or 3 without reaching into private ratchet
state, STOP and report exactly which call is missing — do NOT weaken the test to a tautology.

## Maintenance note

Anything that later reunifies the role interfaces into one, or introduces a group/sender-key
to "optimize" fan-out, threatens §F.1. Reviewers of future group-messaging changes must
re-run `no-shared-sender-key.test.ts` and treat failure as a design regression. Also note the
`token`/`signup` coupling: keep the account plane out of `MessageTransport` so P2P never
inherits a bearer-token assumption.

## Escape hatches

- `Transport` already split at execution HEAD → STOP, report, don't re-split.
- Migrating a call site requires a behavior change to stay green → STOP; the boundary is
  wrong. Report the specific call site.
- The §F.1 test can't be written without editing `group.ts` source → STOP and report.
- The four-plane split can't cleanly separate account from directory/membership because the
  relay threads one `token` through all of them → that coupling is *relay-specific*; model it
  as "the relay impl happens to need a token for three of the four roles," not as a shared
  interface dependency. If that can't be expressed without leaking `token` into
  `MessageTransport` → STOP and report (it means the message plane isn't actually independent).
