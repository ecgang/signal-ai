# signal-ai

An open-source, end-to-end-encrypted group messenger where an **AI agent is a first-class member of the conversation** — it holds its own Signal-protocol identity keys, is invited into a thread explicitly, appears in the member list like any human, and when it is removed, new messages are simply never encrypted to it again.

Built on the official [libsignal](https://github.com/signalapp/libsignal) protocol library. **No cryptography is invented here** — messages are encrypted with the same X3DH/PQXDH + Double Ratchet primitives Signal ships, via `@signalapp/libsignal-client`.

## What this is (and what it is not)

- Messages are **pairwise end-to-end encrypted** to every member of a thread, including the AI member. The relay server only ever stores ciphertext.
- Group **membership is coordinated by the relay** (not by a cryptographic group protocol in this MVP). That is a deliberate, documented trade-off — the honest threat model, including what the relay can and cannot do and what the AI member can see, lives in [`SECURITY.md`](./SECURITY.md).
- This is a **CLI-first alpha (v0.1)**. A desktop GUI is planned for v0.2.

This README intentionally makes **scoped** claims. It does not claim to match Signal's group-messaging security guarantees, and it does not claim any property is "provable" without pointing you to the exact mechanism and its limits in `SECURITY.md`.

## Architecture

A pnpm + TypeScript monorepo:

| Package | Role |
|---|---|
| `packages/core` | libsignal wrapper: identities, prekeys, sessions, pairwise group fan-out |
| `packages/proto` | zod-validated wire + API contract (envelopes, REST, WS frames) |
| `packages/client-sdk` | headless client used by the CLI, the AI agent, and tests |
| `apps/relay` | Fastify + Postgres relay: ciphertext store-and-forward, key directory |
| `apps/agent` | the AI member — a headless client with its own keys + a pluggable LLM (provider-agnostic OpenAI-compatible client; default Nemotron, Anthropic also supported) |
| `apps/cli` | the terminal client (the v0.1 product surface) |

## Develop

Requirements: Node 20, pnpm 8, Docker (for the relay's Postgres in later phases).

```sh
pnpm install       # install workspace + native libsignal addon
pnpm -r typecheck  # type-check every package
pnpm -r lint       # lint every package
pnpm -r test       # run every package's tests (incl. the libsignal load smoke test)
```

## License

Licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0). See [`LICENSE`](./LICENSE). Running a modified version of this software as a network service obligates you to offer that modified source to its users.
