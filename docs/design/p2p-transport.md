# P2P Transport Architecture — signal-ai

- **Status:** REVIEWED (Liotta design · Linus security · Neo boundaries) — hardened. Ready for `/improve` → `/codex:adversarial-review` → `/supergoal` planning. **Not yet implemented.**
- **Date:** 2026-07-05
- **Implements:** ADR 0001 (no central operator)
- **Prior art / references:** [`prior-art.md`](./prior-art.md) (gurk-rs + presage as UX/store references; explicitly NOT a transport model).
- **Ground truth:** the coupling map (transport already behind one `Transport` interface, swappability 8/10) and `~/vault/Research/Pears Runtime` analysis. This doc builds on both; it does not re-scan.

---

## Review synthesis (what the three reviewers changed)

This design went through the planning-phase reviewer panel before any code. Verdicts and the deltas folded into this doc:

- **Liotta (architecture):** thesis accepted — P2P here is *subtraction* (delete central authority; move directory+membership into signatures) + one connectivity swap. Reject Autobase/Hypercore as v1 data model. This is the doc's spine (§ thesis, §A).
- **Neo (module boundaries):** **the `Transport` interface fractures under the swap — split it FIRST.** Five membership methods invert meaning (RPC-with-round-trip → local signed-op-append with zero I/O). Three locks, folded into §C: (1) split `Transport`→`MessageTransport` + a new `MembershipService`, done as a **no-behavior-change refactor on the *current relay* first**; (2) `packages/membership` depends on core+proto, never the reverse — `group.ts` takes the recipient set as an explicit parameter (dependency inversion) to avoid a `core→membership→core` cycle; (3) split `WsLink` into a neutral `DuplexLink` + mailbox-drain as a *negotiated capability*. Lock #1 is the decision that determines whether this is phaseable at all → new **Phase P-1** in §D.
- **Linus (security):** **BLOCKED on the removal-loses-decryption invariant and five more items** — none fatal to the approach (the subtraction thesis is sound), all fixable at the design stage. The six required resolutions are captured in the new **§F Threat model & accepted boundaries** and cross-referenced from §B.1/§B.2/§B.3. P2 ("removal enforced by crypto") cannot pass gate until §F items 1–3 are resolved with code-level evidence.

The load-bearing takeaway: **verify "no shared sender-key" against `packages/core/src/group.ts` with an actual test *before* any membership code lands** (§F item 1). It is the single highest-severity fact in the design and is currently an assertion, not a verified fact.

---

## The contrarian thesis (read this first)

The naive plan is "adopt the Pears stack" — Corestore + Autobase + Hypercore + Hyperswarm + blind-peer — and rebuild directory, membership, and mailbox as a distributed system. That is a multi-month distributed-systems rewrite whose hardest bugs (eventual-consistency divergence, non-deterministic `apply`, quorum liveness) all land at once, and it delays the only milestone that matters: **Dustin uses it.**

The 10x-leverage observation the coupling map hands us: **the three "central authority" jobs the relay does today are three *independent* problems with wildly different difficulty, and only ONE of them actually needs P2P infrastructure.**

1. **Directory** (username→identity→prekey bundle) — not a distributed-systems problem. It is a *publish/lookup of signed, self-authenticating blobs*. Solvable with DHT mutable records + invite links. No consensus.
2. **Membership** (add/remove/aiMode) — for a 3-person group this is **not** a job for Autobase's multi-writer linearization engine. It is a small **signed append-only op-log that rides the E2EE pairwise channel we already have** (`packages/core/src/group.ts` fan-out is transport-agnostic). Deterministic apply over signed ops; no new replication substrate.
3. **Availability/offline mailbox** — the *only* piece that genuinely requires an always-on box. And ADR 0001 already decided that box exists and who runs it: **the self-hosted node = the AI node = the blind-peer mailbox, run by a participant, not by us.**

So "the P2P transport" is not a rewrite. It is: swap the *routing* (DHT direct-connect by pubkey) behind the existing `openSocket()` seam, move *directory* and *membership* **up** into the E2EE payload layer that is already transport-agnostic, and demote `apps/relay` into the optional self-hosted availability node. Membership and directory stop being "call the server" and become "verify a signature" — which is *strictly better* for the no-operator goal than any distributed database, because there is no shared mutable state to converge at all.

**We reject adopting Hypercore/Autobase as the data model in v1.** Rationale below (§A). We keep libsignal; we invent no crypto.

---

## A. Substrate choice

**Decision: HyperDHT + Hyperswarm for connectivity only. Reject Hypercore/Autobase/Corestore as the v1 data model. Reject nostr as primary (keep as a documented fallback for bootstrap/NAT).**

### Why hyperswarm/HyperDHT wins the connectivity layer
- Peers addressed by 32-byte public key, not IP — exactly our identity model (libsignal identity key → connection). Survives network/device roaming (research §1).
- Hole-punched, Secretstream-encrypted UDP direct connections; `relayThrough` fallback for symmetric NAT (research §1). This is the mature, batteries-included answer to the routing problem the relay solves today.
- Node/TS-native (`hyperswarm`, `hyperdht`, `bare`-compatible but runs on Node). Fits the monorepo with zero language boundary.
- It maps **cleanly onto the one seam we have**: `Transport.openSocket()` (transport.ts:38-56) and `WsLink` (connection.ts). A hyperswarm connection is a duplex stream; `WsLink`'s frame semantics (ready/deliver/ack/seq) ride it unchanged (§C).

### Why we do NOT adopt Hypercore/Autobase as the data model (the contrarian cut)
Hypercore's core value is *cryptographically-verified, ordered, append-only replication of a log*. **We already have that property from the Double Ratchet** — messages are ordered, authenticated, and tamper-evident per pairwise session. Layering Hypercore under opaque libsignal ciphertext blobs is **redundant machinery**: we would pay Autobase's eventual-consistency tax (reordering on offline-writer merge, mandatory-deterministic `apply`, quorum/indexer liveness — research §3) to re-derive guarantees the ratchet already gives us, for payloads Hypercore cannot even interpret (they are opaque ciphertext).

The one place Autobase looked compelling is **multi-writer group membership**. But for our scale (3–N members, N small, human-run groups) the multi-writer linearization engine is over-engineering. A **signed membership op-log delivered over the existing E2EE fan-out** (§B.2) gives verifiable, operator-free membership with *no shared mutable database to converge* — a smaller attack surface and no eventual-consistency bug class. If groups ever grow to hundreds of churning writers, Autobase becomes the right upgrade; we design the membership module so that swap is possible (§B.2), but we do not pay for it now.

### Why not nostr as primary
Nostr's event-relay model reintroduces operators (relay hosts) — decentralized but still third-party machines seeing envelope metadata and timing. Its events are public-by-default, awkward for tight private groups, and it gives us nothing HyperDHT doesn't for direct pubkey connectivity. **Kept as a documented fallback** for two narrow uses if HyperDHT bootstrap/NAT proves painful: (a) an alternate bootstrap/discovery hint channel, (b) a last-resort ciphertext relay. Not v1.

### The honest contrarian answer to "is full P2P even the right FIRST step?"
**No — and the ADR already agrees.** The highest-leverage sequencing is a **hybrid where the operator we remove is the operator we run *for other people*, not every always-on box.** v1 ships as: DHT direct-connect as the default path + the current relay **demoted to a self-hostable node that Eric runs for himself**. That is not "a central operator" in the ADR's sense (§ADR decision 3: the always-on box becomes optional and self-hostable). It lets Dustin test the P2P direct-connect path *and* the mailbox path in one milestone without a big-bang rewrite, because each piece lands behind the `Transport` seam incrementally.

---

## B. The three open problems — concrete mechanisms

### B.1 Prekey distribution without a directory

X3DH needs a peer's signed prekey bundle when they are offline. Today: relay serves bundles with atomic one-time-prekey consumption (relay index.ts:227,250), client caches to `stores.directory` (client.ts:377-384, stores.ts:62,87-94). The hard dependency is username→userId→bundle (coupling map §3).

**Mechanism — three layers, self-authenticating:**

1. **Identity = public key. Drop server-assigned usernames as the identity primitive.** A peer *is* their libsignal identity key. Human-readable names become **local petnames** (Zooko's triangle: we take secure + decentralized, drop global-unique). This removes the entire username→userId central-resolution dependency (client.ts:423 `fetchBundlesByUserId`) rather than reimplementing it P2P. Petnames live in the local `directory` store; they are a display convenience, never a trust anchor. `/verify` (local sha256 fingerprints) remains the trust surface, untouched.

2. **Invite = `pear://`-style link carrying the bootstrap bundle inline.** First contact is out-of-band (research §5): the invite link Eric sends Dustin contains Eric's identity key + a signed prekey bundle snapshot + a DHT discovery topic. Zero directory lookup for first contact — the bundle travels *with* the invitation. This directly replaces invite-code gating (relay index.ts:179-190): possession of the link is the capability.

3. **Steady-state bundle refresh = DHT mutable records, signed.** Each peer publishes a **signed prekey bundle** to a HyperDHT mutable record keyed by their identity pubkey (`node.mutablePut`, signature verified on `mutableGet`). The bundle is self-authenticating: it is signed by the identity key, so a malicious DHT node cannot forge it — it can at most withhold/serve-stale (mitigation: bundles carry a monotonic counter + expiry; a stale bundle only costs a retryable session-setup failure, never a MITM, because the signed-prekey signature chains to the identity key `/verify` pins).
   - **One-time prekey exhaustion:** the atomic one-time-prekey consumption the relay does (index.ts:250) has no global authority in P2P. **Resolution: fall back to signed-prekey-only X3DH when one-time prekeys are exhausted** (libsignal supports this; it is the documented degraded mode — slightly weaker forward secrecy for the *initial* message only, ratchet heals immediately). The self-hosted node (§B.3), when present, can host + atomically vend one-time prekeys for its owner, restoring full strength. **Open question flagged for Linus:** confirm libsignal-client 0.96.4 exposes signed-prekey-only bundle processing and quantify the FS delta; if not, one-time prekeys must be node-hosted and offline-first-contact degrades.

**Source of truth:** the peer's own signature. No directory to be authoritative. A DHT node is an untrusted cache; every value is verified against the identity key the recipient already pinned via `/verify`.

> **Linus §F.5 — two prekey gaps that must be fixed or explicitly accepted before P3 enables DHT bundle refresh:**
> - **OTK reuse via the static `pear://` invite link.** The invite carries a *snapshot* bundle in a shareable link. If the link is forwarded / leaked / re-clicked, the same one-time prekey is consumed twice with **no detection** — there is no atomic single-vend authority on the no-node path (the monotonic counter fixes staleness *detection*, not concurrent *consumption*). Two concurrent DHT fetches hit the same failure. **Resolution:** treat the invite bundle's OTK as best-effort-only; on any suspected reuse fall through to signed-prekey-only X3DH (§F.1) and let the ratchet heal. When a node is present (§B.3) it is the atomic OTK vendor and this gap closes. Document that an invite link is single-use-by-intent.
> - **Downgrade oracle.** A withholding DHT node can selectively strip OTKs to *force* signed-prekey-only mode even when fresh ones exist, and the recipient cannot distinguish "genuinely exhausted" from "stripped." This is strictly weaker than the relay's atomic vend (index.ts:227,250), which has no DHT equivalent in the default install. **Resolution:** accept as a documented degraded-FS boundary for the no-node path (initial message only; ratchet heals); the node path restores atomic vend. State it plainly, do not let "P2P prekeys" imply relay-equivalent strength.

### B.2 Group membership over a signed op-log (not Autobase in v1)

Today membership is relay-authoritative Postgres (client.ts:457-484 delegates mutations then re-`listMembers`; :505-516 reads membership+aiMode from relay every refresh; relay enforces on enqueue index.ts:535-542). This is the deepest coupling and the one most people would reach for Autobase to solve.

**Mechanism — membership as a signed, hash-chained op-log riding the existing E2EE fan-out:**

- **Op types:** `create(groupId, founderKey)`, `addMember(key, bundle)`, `removeMember(key)`, `setAiMode(bool)`. Each op is `{ prevHash, seq, author, payload, sig }` — signed by the author's identity key, chained by hash to the previous op (a tiny per-group Merkle chain). This reuses the proto envelope; ops are just a `PlaintextMessage` variant (proto index.ts:61-71), fanned out over `packages/core/src/group.ts` pairwise fan-out **which is already transport-agnostic** (coupling map: core is AGNOSTIC, must not change — and it doesn't; we add a message type, not networking).
- **Authorization (the rules that make it verifiable, not just eventually-consistent):**
  - Only the **founder** (creator identity key, pinned in `create`) may add/remove in v1. This is the deliberate simplification that lets us skip Autobase: **single-writer for membership ops** collapses the multi-writer linearization problem entirely. `aiMode` toggle: founder-only in v1.
  - Every member independently validates the chain (signatures + hash links + author-is-founder) and applies deterministically. Divergence is impossible because there is one writer; there is no reordering-on-merge bug (research §3) because there is no multi-writer merge.
- **The removal-loses-decryption guarantee moves from transport-enforced to crypto-enforced — and Linus BLOCKED it as under-specified. The honest, corrected statement (see §F.1–F.2):** Today removal is a two-gate transport refusal (relay refuses enqueue: index.ts:535-542; memory: "reusable relay-refusal removal-proof pattern") — enforced *regardless of client honesty*, at a single authority. In P2P there is **no relay to refuse**, so the guarantee decomposes into parts with different strengths, and we must state each honestly rather than let "crypto-enforced" imply a blanket guarantee:
  - **Sender-side confidentiality (the part that holds):** on `removeMember`, honest members stop including the removed key in `core/group.ts` fan-out. If fan-out is strictly pairwise with **no shared sender-key** (asserted by memory/ADR but **NOT yet verified in code** — this is §F.1, the highest-severity open fact), there is no group key to rotate and the removed member simply receives nothing new. **If any shared sender-key exists, removal MUST trigger epoch rotation** — this must be settled with a code assertion *before* membership code lands, not discovered in P2.
  - **Malicious-member continued-send (accepted boundary, §F.2):** a *modified* client can keep encrypting to the removed peer's still-valid pairwise session — there is no chokepoint to stop it, and pure pairwise Double Ratchet structurally cannot compel it (that needs a chokepoint or MLS-style TreeKEM). This is a **real regression vs. the relay** and is stated as an explicit accepted threat-model boundary, not hidden behind "crypto-enforced."
  - **Propagation race (§F.2):** removal ops ride the same eventually-delivered fan-out as messages. A sender who is offline when `removeMember` issues keeps encrypting to the removed peer until their local fold updates on reconnect. The relay made removal atomic; this model makes it eventually-consistent per-sender. Real window, must be documented.
  - **Receiver-side enforcement (§F.2 — was missing entirely):** removal must ALSO block the removed member's *outbound* messages to remaining members. Their pairwise sessions with everyone are untouched, so every honest client MUST reject inbound messages whose sender is not in its current local membership fold. Without this, a removed member retains *write* access to the group. This is now a required mechanism, not an optional detail.
- **Op-log integrity — three gaps Linus flagged as structurally unaddressed (§F.3–F.4):**
  - **Genesis bootstrap for later members (§F.3):** ops are pairwise-fanned-out, so `create` (op #1) was only ever encrypted to the members who existed then. A member added later has **no path to the full historical chain** unless the founder explicitly re-sends the entire signed log over the fresh pairwise session at add-time. This mechanism must be specified — it is a hole, not a detail.
  - **Truncation/withholding (§F.3):** signatures + hash-chaining stop forgery but not a malicious relayer handing a new member only ops 1..k and withholding a later `removeMember`. With Postgres's single-source-of-truth gone, there is no "authoritative current head." Mitigation: op `seq` is dense and gap-checked; the node (§B.3) and every member serve their head; a member folding a chain with a missing successor to a known op treats it as an integrity failure. Full "provably-latest" needs more (deferred, documented).
  - **Founder key loss/compromise (§F.4):** single-founder-writer reintroduces a single point of failure at the crypto layer. Loss bricks membership forever; compromise gives silent unrevocable authority. **v1 decision: accept and document** ("MVP: lose the founder key, the group bricks; no succession") — but it must be *stated*, not silent.
- **Source of truth:** the hash-chained signed log itself, replicated to every member. `listMembers` (client.ts:505-516) becomes a **local fold over the log**, not a relay round-trip. The self-hosted node, when present, holds the log too and serves it to members who were offline during ops (availability, not authority — and subject to the truncation caveat above).
- **Upgrade path preserved:** if single-founder-writer proves too limiting (co-admins, large churning groups), the op-log's `apply` is already a deterministic reducer — swapping in Autobase's multi-writer linearization is then a contained change to the membership module, not a redesign. We pay for it only if we need it.

### B.3 Availability / offline mailbox = the unified self-hosted node

The mailbox is entirely relay-side today (relay db.ts enqueue/drain/ack; index.ts:430-504 drain-on-`ready` + live-push; per-device per-seq exact ack). The client *assumes drain-on-`ready` exists* (connection.ts:36-40) with no polling. Research §2 is unambiguous: reliable offline delivery **requires an always-on peer holding the data**. ADR 0001 decision 3+4 already resolved *who*: the **self-hosted node**, which is simultaneously the blind-peer mailbox AND the AI member's host.

**Mechanism:**

- **What it is:** `apps/relay` is **not deleted — it is demoted** into `apps/node` (rename), stripped of its authority roles. It keeps *only* the ciphertext store-and-forward mailbox (db.ts enqueue/drain/ack, the per-device per-seq exact-ack machinery — the golden-flake-fix invariant survives verbatim). It loses: signup/invite gating (§B.1 kills it), prekey directory authority (§B.1 makes it an optional one-time-prekey host for its owner), membership authority (§B.2 moves it to the signed log).
- **What it holds:** ciphertext envelopes only (EnvelopeSchema, base64 ciphertext — unchanged). It is a **blind peer**: it stores-and-forwards without decrypting. It cannot read the social graph beyond "these device-keys have mailboxes here" — and since a node is self-hosted by one user for their own group, that is the user's own graph.
- **How peers find it:** the node announces itself on the group's HyperDHT topic (from the invite link) and/or its address is included in the invite bundle. Peers open a hyperswarm connection to it exactly as they would to a human peer — it is just an always-on peer that happens to hold the backlog. `Transport.openSocket()` connects to it via the same code path as a direct peer.
- **Unification with the AI (one install, two isolated modules — Neo boundary + Linus §F.6):** the AI member (apps/agent, phase 5) is an *ordinary always-on full peer* (research §4 — it needs plaintext, so it is not blind). "One box gives you both AI-in-the-loop AND offline delivery" is the *deployment* win. But the two roles are opposites — the mailbox is ciphertext-only *storage*; the AI holds real session/identity **key material**. Fusing them into one module is a god-object and a security hazard: the mailbox accepts raw duplex-stream connections from arbitrary hyperswarm peers (a larger, less-audited attack surface than Fastify+TLS), and any parse bug in that path reaches the AI's keys if they share an address space.
  - **Decision:** `apps/node` is a **thin process shell** wiring two separate modules: a `MailboxService` (the demoted relay's store/drain/ack, ciphertext-only) and `apps/agent` running as an **ordinary `SignalAiClient` over `transport-p2p`**. **Hard rule: the agent connects *as a client*; it never reads the mailbox DB directly.** Co-location must not become coupling — no shared mutable state beyond the hyperswarm listener.
  - v1 accepts "single-owner box, full compromise is full compromise anyway" as the isolation stance (both are the node owner's own trust domain), but the *module* boundary (agent-as-client, no direct DB access) is enforced regardless, so hardening to process/privilege isolation later is a config change, not a redesign. This is §F.6.
- **Liveness honesty:** with no node running and all humans offline, the group is dark until someone returns (ADR open problem 3, accepted for local-first). The node is the *opt-in* fix. **This is fine for the Dustin milestone: Eric runs one node.**

---

## C. Migration shape mapped to the coupling map

**Stays behind `Transport` as-is (no change):**
- `packages/core/*` — libsignal crypto, pairwise fan-out (`group.ts`). AGNOSTIC. Adds nothing but a new *message-type* for membership ops (§B.2), which is payload, not networking.
- The `EnvelopeSchema` ciphertext format (proto index.ts:39-53), `PlaintextMessage` (:61-71), `PreKeyBundlePublic` (:151-165) — NEUTRAL, reused verbatim.
- `apps/cli/*` + TUI — relay is "just a `relayUrl` string." It becomes "a `pear://` invite string / node address." No TUI change beyond the connect-string format.
- `/verify` trust surface — untouched; in fact it becomes *more* load-bearing (it is now the only trust anchor, §B.1).

**Must generalize — but split the interface FIRST (Neo lock #1, the decision that makes this phaseable):**

Neo's blocking finding: the current `Transport` interface (transport.ts:38-56) **fractures under the swap**. `fetchBundles`/`openSocket` survive honestly ("fetch bytes / open stream" is transport-neutral), but `createConversation`/`invite`/`removeMember`/`setAiMode`/`listMembers` **invert meaning** — today "request an authority mutation, await confirmation"; in P2P "append a local signed op, fan out, no round-trip." `listMembers` degrades from an authoritative fetch to a synchronous local fold with **zero I/O** behind the `Promise`. Cramming a local log-fold behind an RPC-named method is the leaky abstraction to avoid. So:

- **Split `Transport` before writing any P2P code, as a no-behavior-change refactor on the *current relay*.** The real `Transport` (transport.ts:38-56, confirmed by code inspection) bundles **four planes**, not two — there is **no REST `send`**; messages ride the WebSocket via `openSocket()`. It splits into four role interfaces (Plan 001 is authoritative on the exact members; this table must match it):
  - `MessageTransport` = **`openSocket` only** — the message-delivery plane (framing/ack/deliver over a duplex stream). This is the **sole** plane P2P reimplements. Both `createHttpWsTransport` and the future `createP2pTransport` implement *this* and nothing else.
  - `DirectoryService` = `publishDevice` + `fetchBundles` + `fetchBundlesByUserId`. Prekey/device directory. In P2P this becomes DHT-published signed bundles (P3), not part of `MessageTransport`.
  - `AccountService` = `signup`. Dropped entirely in P2P (identity = keypair, no account creation).
  - `MembershipService` = `createConversation`/`invite`/`removeMember`/`setAiMode`/`listMembers`. Sits **above** transport, backed by `packages/membership`, and drives fan-out. On the relay it wraps the current RPC calls (no behavior change); in P2P it appends to the signed op-log. This is **Phase P-1** (§D) — it lands on the relay first, so P0's P2P impl only has to satisfy the small honest `MessageTransport`.
  - **P0 no-stub acceptance check (Plan 002, load-bearing):** `transport-p2p.ts` must type-check and function implementing `MessageTransport` **alone** — it must NOT import, implement, or stub `DirectoryService`/`AccountService`/`MembershipService`. Directory methods do **not** belong on `MessageTransport`; putting them back recreates the big-bang cutover the split exists to prevent. If P0 finds it can't work without them, the split boundary is wrong → STOP and report, do not paper over with stubs.
- **`WsLink` (connection.ts) — split into two layers (Neo lock #3).** Its frame semantics are two concerns wearing one class:
  - **`DuplexLink` (neutral):** framing + per-seq ordering/ack + `deliver` routing + backoff reconnect over *any* duplex byte stream — a WS to a node OR a hyperswarm connection to a direct peer. Auth stays in **link-establishment**, out of the frame protocol (hyperswarm connections are already pubkey-authenticated + Secretstream-encrypted, so the subprotocol-token auth-first-frame is redundant there).
  - **mailbox-drain = a negotiated capability**, not baked into every link. A node connection has drain-on-connect (backlog is a mailbox concept); a direct peer connection genuinely has none — modeled as an explicit *no-op drain capability*, **not** a faked empty mailbox (settles open-Q#3 honestly). connection.ts:36-40's drain semantics move into the node-capable link only.
- **`signup`** → deleted (identity = keypair, no account creation). **`openSocket`** → hyperswarm connect (to peer or node), behind `MessageTransport`.

**Net-new modules:**
- `packages/client-sdk/src/transport-p2p.ts` — `createP2pTransport()`, the second concrete `MessageTransport` impl beside `createHttpWsTransport` (transport.ts:90-151). This is where the 8/10 swappability pays off — and it stays small *because* P-1 shrank the interface.
- `packages/p2p/` (new) — hyperswarm/HyperDHT wrapper: `dial(pubkey)`, `announce(topic)`, `mutablePut/Get(bundle)`. Thin; deals **only in pubkeys + byte streams** and depends on **neither proto nor core** (Neo: avoids a dependency cycle). Isolates the Pears dependency behind our own interface so it is swappable/testable.
- `packages/membership/` (new) — the signed op-log: op schema, sign/verify, hash-chain validation, deterministic `apply`/fold, rekey-on-remove hook, receiver-side membership check (§F.2), genesis re-send on add (§F.3). **Neo lock #2 — pin the dependency direction:** membership depends on `core`+`proto`, **never the reverse**. Because fan-out needs the member set, `core/group.ts` must take the recipient set as an **explicit parameter** (dependency inversion) — if `group.ts` imported membership we'd get a `core→membership→core` cycle. This is not client-sdk (it's transport-agnostic) and not core (founder-only *authorization policy* doesn't belong in the crypto wrapper). Op schema lives in `proto`.
- `apps/node/` — renamed/demoted `apps/relay`: a thin process shell over a ciphertext-only `MailboxService` + optional one-time-prekey vendor + `apps/agent` as an ordinary client (§B.3, §F.6). Deletes signup/invite/membership authority code.

**What happens to `apps/relay`:** demoted, not deleted (§B.3). Its mailbox is the one genuinely valuable always-on capability and it becomes the self-hosted node. Its authority code (Postgres membership, invite gating, directory) is deleted.

**Forced changes to the untouchable set:** none intended. The one risk: if membership ops need a field the current `PlaintextMessage`/envelope can't carry, proto changes — but proto is NEUTRAL, and the recent `memberUserIds .min(1)` widen (memory: phase 6) shows proto evolves without breaking core. Flag for Neo: keep membership-op schema in `packages/membership`, referenced by proto, not baked into the neutral envelope.

---

## D. Phasing toward "Dustin tests the P2P version"

Hard requirement: Dustin (remote friend) uses the P2P build in a 3-way group with Eric + the AI. De-risk the killers in order: **interface split first (unblocks phasing), NAT traversal (it can sink everything), then offline delivery, then membership.**

**Phase P-1 — interface split refactor on the *current relay* (Neo lock #1 — do this before any P2P code).**
Split `Transport`→`MessageTransport` + `MembershipService` and `WsLink`→`DuplexLink` + drain-capability, as a **no-behavior-change refactor against the existing HTTP/WS relay**. Green build + all existing tests still passing IS the acceptance check — nothing user-visible changes. Also land the §F.1 assertion here: a test in `packages/core` proving `group.ts` fan-out uses **no shared sender-key** (or, if one exists, the removal-epoch-rotation requirement is written down before membership work starts). This phase is pure de-risking: it makes P0's `MessageTransport` small and honest and settles the highest-severity security fact while there is still nothing to revert.

**Phase P0 — P2P direct connect, two humans, both online (de-risk NAT).**
Build `packages/p2p` + `transport-p2p.ts`; get Eric↔Dustin a hyperswarm direct connection by pubkey, libsignal envelopes flowing over it, both online. Invite = `pear://` link with inline bundle (§B.1 layers 1–2, no DHT refresh yet). Membership hardcoded/founder-only, no removal. **Demoable milestone: Eric and Dustin chat P2P, no relay in the path.** This proves the single scariest thing (hole-punching across their real networks) earliest. If symmetric-NAT bites, wire `relayThrough` (Eric's node as relay) — still no central operator we run for others.

**Phase P1 — offline delivery via the self-hosted node (de-risk availability).**
Demote `apps/relay`→`apps/node`; Eric runs one node. Node = blind-peer mailbox reachable on the group topic. `WsLink` generalized so the client drains backlog from the node on connect and gets live-push, exactly as today (connection.ts:36-40 semantics preserved). **Demoable: Dustin sends while Eric is offline; Eric gets it on reconnect from Eric's node.** Reuses the battle-tested per-seq exact-ack drain code verbatim — lowest-risk reuse of existing invariant.

**Phase P2 — signed membership log + the AI as third member (de-risk consistency + deliver the actual goal).**
Build `packages/membership`; move add/remove/aiMode to the founder-signed op-log folded locally. Run `apps/agent` in `apps/node` as the always-on AI full peer. **THE milestone: Eric + Dustin + AI, 3-way P2P group, AI always in the loop because Eric's node is always on.** Removal enforced by crypto (§B.2) — Linus gates this before it ships.

**Phase P3 — steady-state hardening.** DHT mutable-record bundle refresh (§B.1 layer 3), one-time-prekey node hosting, petname UX, `/verify` re-emphasis, remove any remaining relay-authority code paths.

**What could sink the timeline (flagged):**
1. **Symmetric-NAT hole-punch failure between Eric and Dustin's specific networks** — P0 exists precisely to find this in week 1. Mitigation: `relayThrough` via Eric's node.
2. **libsignal one-time-prekey exhaustion / signed-prekey-only mode** (§B.1 open question) — if 0.96.4 doesn't cleanly support degraded X3DH, offline-first-contact needs node-hosted prekeys, pulling P3 work into P1.
3. **The removal rekey invariant (§B.2)** — if a shared sender-key exists anywhere, removal-loses-decryption needs epoch rotation, not just fan-out exclusion. Must be settled at design review, not discovered in P2.

---

## E. Top 3 risks + honest recommendation

**Risk 1 — NAT traversal is probabilistic, and our whole "remote friend" promise rides on it.** HyperDHT hole-punching is "not guaranteed on symmetric NAT" (research §1). If Dustin is behind carrier-grade NAT, direct connect fails and we fall to `relayThrough` — which quietly reintroduces an always-on relay (Eric's node), acceptable per ADR but it means "pure P2P direct" is not guaranteed for all peers. *Mitigation:* P0 tests it first; the node doubles as the relay fallback anyway.

**Risk 2 — the removal-loses-decryption guarantee moves from transport-enforced to crypto-enforced.** Today the relay refuses to enqueue for a removed member — a clean choke point. In P2P there is no choke point; correctness depends entirely on honest members excluding the removed key from fan-out (and epoch rotation if any shared key exists). This is the highest-severity security change in the design and is exactly why Linus reviews §B.2 before P2 ships. *Mitigation:* single-founder-writer membership + explicit rekey invariant + Linus gate.

**Risk 3 — availability liveness is genuinely weaker than the relay.** With Eric's node down and everyone offline, the group is dark (research §2, ADR open problem 3). The always-on relay never had this failure mode. *Mitigation:* the self-hosted node IS the mitigation; we accept dark-when-all-offline as the local-first default and sell always-on as the node's value prop.

**Risk 4 — IP exposure to contacts (Linus's biggest silent regression, §F.7).** Direct hyperswarm connections expose each peer's **real IP** to everyone they talk to (and to DHT-adjacent nodes during hole-punch). The relay model hid client IPs from each other entirely — clients only ever saw the relay. Given the ADR's stated goal is *discretion*, trading a ciphertext-only operator's metadata visibility for direct IP exposure to your own contacts is a real tradeoff that partially undermines the pitch. *Mitigation:* state it plainly in ADR 0001 and onboarding copy (do not overstate "discretion"); `relayThrough`/node-mediated paths reduce direct exposure at the cost of reintroducing a hop. **Action: update ADR 0001 consequences with this tradeoff** — it is currently unstated there.

**Recommendation — do the P2P work NOW, but as the *hybrid demotion*, not a big-bang rewrite, and only *after* a relay-based Dustin smoke test proves the product loop.**

The swappability is 8/10 *because* someone already isolated `Transport`. That investment is wasting away if we don't exercise the second impl. But the ADR's own sequencing (decision 5: "the MVP relay stays until it's earned its replacement") is correct: **get Dustin on the current relay first to validate the product** (invites, group chat, AI member all work end-to-end as a *product*), *then* run the P2P phases P0→P2 to swap the transport under a validated product. Doing P2P before the product loop is proven risks debugging distributed-systems edge cases for a UX nobody has confirmed they want.

The decisive contrarian point: **P2P here is mostly a *subtraction* (delete central authority, move directory+membership into signatures) plus one connectivity swap — not an addition of a distributed database.** That is why it is tractable now and why rejecting Autobase-in-v1 is the leverage move. If this doc's §B.2 single-writer simplification survives Linus, the "hard" membership problem is an afternoon of signature verification, not a consensus system.

> **Sequencing decision (Eric, 2026-07-05 — OVERRIDES the relay-first recommendation above).** The paragraph above (and ADR 0001 decision 5) recommends validating the product on the current relay with Dustin *before* building P2P. Eric decided the opposite: **Dustin's first real test is the P2P build** — verbatim, "I'd rather have Dustin test the P2P version when we get it designed and built out." So the active track is P0→P2 (plans 001→004) **now**; the relay is retained only as the ciphertext-only fallback substrate it becomes in Plan 003, not as a Dustin-facing validation milestone. The reviewers' rationale is preserved here as recorded context, not as the plan of record (memory: `signal-ai-p2p-direction`).

---

## F. Threat model & accepted boundaries (Linus BLOCKED items — must be resolved/accepted before P2 ships)

Linus's verdict was **BLOCKED**, not reject: the subtraction thesis is sound and the phasing is sensible, but six items must be *resolved with evidence or explicitly accepted in writing* before the crypto-enforced removal (P2) can pass gate. This section is the checklist a `/goal` §4b Verifier Contract will gate on. "Flagged as an open question" ≠ "resolved."

| # | Item | Type | Gate / resolution | Blocks |
|---|------|------|-------------------|--------|
| **F.1** | **No shared sender-key** in `core/group.ts` fan-out | Must **verify in code** | Grep + a test in `packages/core` asserting no group-wide symmetric key, landed in **Phase P-1** before any membership code. If one exists → removal MUST trigger epoch rotation, designed before P2. | P2 (highest severity) |
| **F.2** | Removal enforcement holes: malicious-member continued-send, propagation race, **receiver-side enforcement** | Decide + **document accepted boundary**; implement receiver check **+ authenticated wire metadata** | Write the accepted threat model into §B.2 (done). *Implement* receiver-side "reject inbound from sender not in local fold as of the message's log position" in `packages/membership`. **Required mechanism (Plan 004 PREREQ-1):** an authenticated membership-head reference `(seq, headHash)` carried **inside the ratchet-encrypted `PlaintextMessageSchema`** (NOT the cleartext `EnvelopeSchema`, which a node can forge); old clients omitting it **fail closed** (receiver rejects, never default-accepts). Verifier must confirm the check keys off this authenticated position, and the propagation-race tie-break (a message referencing a head ≥ the `remove` is rejected). | P2 |
| **F.3** | Op-log **genesis bootstrap** for later-added members + truncation/withholding | Must **specify mechanism** — hash-chain validity alone is insufficient | Founder re-sends full signed chain over the fresh pairwise session at add-time; dense gap-checked `seq`; missing-successor = integrity failure (§B.2). **Truncation/withholding is NOT closed by the hash-chain alone** — a valid *prefix* omitting a later `remove` is internally valid. **Required mechanism (Plan 004 PREREQ-2, NOT quorum/consensus — §A forbids Autobase):** invite-pinned genesis **and** head hash (trust-on-first-use lower bound); monotonic signed-head gossip with receiver **non-regression** (never fold below the highest authenticated head seen); message head-ref (PREREQ-1) lets a lazy receiver detect it's behind and catch up. Verifier tests must construct an *internally-valid* prefix and prove detection comes from this latestness mechanism, not from malformed input. **Explicit fallback:** if latestness can't be guaranteed for a peer with no prior state and a hostile sole source, downgrade the truncation claim to accepted-risk AND **do not delete relay authority** (Plan 003 handlers stay). | P2 |
| **F.4** | Founder key **loss/compromise** (single point of failure) | **Accept + document** for v1 | "MVP: founder key lost → group bricks; no succession." Stated, not silent. Revisit post-MVP (co-admin/rotation). | P2 (doc-only) |
| **F.5** | OTK **reuse via static invite link** + **downgrade oracle** | Fix or **explicitly accept** before P3 | Invite OTK is best-effort; fall through to signed-prekey-only + ratchet heal; node is atomic vendor when present. Document invite links as single-use-by-intent. §B.1. | P3 |
| **F.6** | AI-vs-mailbox **process isolation** | **Decide** before merging into `apps/node` | Module boundary enforced (agent-as-client, no direct DB access); v1 accepts single-owner-box trust domain. §B.3. | P2 |
| **F.7** | **IP exposure** to contacts undermines "discretion" | **State plainly** in ADR + onboarding | Update ADR 0001 consequences; do not overstate discretion; `relayThrough`/node paths mitigate. §E Risk 4. | before any public "P2P = private" claim |

## Open engineering questions (explicit, for review — not papered over)
1. **libsignal 0.96.4 signed-prekey-only X3DH:** supported? FS delta quantified? (blocks §B.1 offline-first-contact) — **load-bearing (Linus): answer by code inspection before P0.**
2. **Shared sender-key existence:** does current fan-out use any shared group key, or is it strictly pairwise? Determines whether removal needs epoch rotation. (blocks §B.2 security) — **= §F.1, resolve in Phase P-1.**
3. **`DuplexLink` drain semantics on a direct (mailbox-less) peer connection** — resolved by §C: model drain as a negotiated capability (no-op on direct peers), not a faked empty mailbox. Safe to defer to P1.
4. **DHT mutable-record write availability/rate-limits** for bundle refresh — is `mutablePut` reliable enough, or must the node always host bundles? (affects §B.1 layer 3; feeds the F.5 downgrade oracle — unreliable writes push more users into degraded mode.)
5. **Petname migration:** does dropping server usernames break any existing CLI/TUI assumption or stored state? (should not — flag confirms.) Safe to defer.
