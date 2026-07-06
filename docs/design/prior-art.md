# Prior Art & References

Projects we studied, what we take from each, and — crucially — what we deliberately do
*not* take. This is a design reference, not a dependency list.

## gurk-rs (`github.com/boxdot/gurk-rs`)

A mature, well-loved (~1.3k★, AGPL-3.0) **terminal client for the real Signal network**,
written in Rust. On first run it shows a QR code and **links as a secondary device to an
existing Signal account** (the user's phone stays primary). Built on **`presage`** — the
Rust library implementing a Signal client against **Signal's own servers** using the
official libsignal libraries. Local store is **SQLite (via `sqlx`)**.

### Borrow (UX / implementation references — NOT transport)
- **Validates the product bet.** A libsignal-backed TUI messenger with real traction is
  proof the terminal-first surface is genuinely wanted. Reassurance our `apps/cli` + TUI
  direction is sound.
- **`presage` as a worked reference** for client-side Signal store/session management —
  useful reading when hardening `packages/core` / `packages/client-sdk`. We do not depend
  on it (Rust, and Signal-network-bound), but its structure is instructive.
- **TUI interaction patterns** — keybinding-config model, channel modal, multiline editing
  — a mature reference for `apps/cli` polish.
- **SQLite-backed store ergonomics** — mirrors our own better-sqlite3 store instinct.
- **AGPL-3.0**, same license as us, so studying its structure directly is fair game.

### Deliberately do NOT take (the axis where it is an anti-model)
- **It is the maximal dependency on a central operator.** Every message routes through
  Signal Inc.'s infrastructure. That is the exact opposite of this project's north star
  (ADR 0001 — no central operator). It does not solve any of our hard problems (P2P
  transport, offline mailbox, membership source-of-truth); it *sidesteps* them by
  outsourcing transport to Signal.
- **It structurally cannot host an AI as a first-class member.** gurk-rs is a client for a
  personal, phone-number-bound Signal account; Signal accounts are not designed for an
  autonomous AI identity in the member list, and automated use of the main Signal network
  is against Signal's ToS. Our defining differentiator cannot exist on that model.

### Relevance to the P2P transport design
**None, directly.** gurk-rs offloads 100% of transport to Signal's servers, so it is
orthogonal to the Pears-vs-nostr, offline-mailbox, and membership-log decisions. It is a
UX/implementation reference only — explicitly *not* an input to the transport architecture.

### The honest takeaway
Starting from gurk-rs would have yielded a working Signal TUI almost immediately — and
made both defining features of this project (AI-as-member, no-central-operator)
permanently impossible. Ours is a deliberate fork away from Signal's network, not an
oversight. gurk-rs earns its place here as proof the *surface* works and as a store/UX
reference — not as an architectural model.
