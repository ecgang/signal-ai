# Confidential Inference: where the AI member's plaintext goes

This document is the honest answer to a question every serious reader of an
"E2EE messenger with an AI member" will ask: **if the AI can read my messages,
in what sense is this still end-to-end encrypted?**

Short version: the crypto is real, the AI is a *member* (not the server), and
the one thing that actually matters — **where the AI decrypts and runs its
model** — is a deployment choice you control. Run inference locally and the
plaintext never leaves your trust boundary.

## 1. E2EE keeps the *server* out, not consented *members*

End-to-end encryption does not promise "nobody else can read your messages." It
promises: only the **endpoints** of a conversation can read the plaintext, and
the relay/server in the middle cannot. Adding a human (Dustin) to a group lets
Dustin read everything — that does not break E2EE. He is an *end*.

The AI member is an endpoint, not the transport. It holds its own Signal
identity keys, appears in the member list, is added by explicit invite, and is
removable. Messages remain encrypted end-to-end; the AI is simply one of the
ends — the same way a Signal linked device is an extra endpoint that holds keys
and reads plaintext. **The relay never sees plaintext, with or without the AI.**

## 2. The unavoidable truth: reading requires decrypting

Any AI that *reads* your messages must have them in plaintext somewhere. That is
information theory, not a Signal limitation — every AI assistant on earth
(ChatGPT, Copilot, Gemini) sees your plaintext. The only technique that would
let a model compute on ciphertext is Fully Homomorphic Encryption (FHE), and as
of 2026 that is not viable for chat-sized models (see §4).

So the real question is never "can the AI avoid decrypting?" (no). It is:
**once the AI decrypts, where does that plaintext go, and whom must you trust
with it?** That is a deployment decision:

| Where inference runs | Plaintext goes to… | Verdict |
|---|---|---|
| **Remote API** (e.g. a hosted NIM/Nemotron endpoint) | a third-party provider, outside your boundary | The weak version. Not "broken crypto" — a member you invited forwards content to its provider. Acceptable **only with explicit disclosure + consent-by-invite.** |
| **Local model** (Ollama/llama.cpp on your box or a Jetson) | nowhere — stays on hardware you control | ✅ Fully consistent with E2EE. No third party. **This is the recommended default.** |
| **TEE / confidential inference** (attested GPU enclave) | decrypted only inside a box the operator provably cannot read, verifiable via remote attestation | Roadmap — the way to offer hosted inference without asking users to trust the operator. |

The only way this design genuinely "breaks the model" is to **market
provider-blindness you do not have** — shipping remote-by-default while claiming
"even we can't read it." We do not make that claim. Local-by-default, remote
disclosed.

## 3. Local inference is the recommended default

Point the agent at a local OpenAI-compatible endpoint — no code change, it is
already provider-agnostic:

```sh
AGENT_PROVIDER=openai-compatible
AGENT_LLM_BASE_URL=http://localhost:11434/v1   # Ollama's OpenAI-compatible API
AGENT_MODEL=qwen3.6:27b-32k                     # size to your hardware
AGENT_LLM_API_KEY=ollama                         # Ollama ignores it; any non-empty value
```

Model sizing (Q4-quantized weights, approximate):

| Class | Params | ~Q4 size | Runs on |
|---|---|---|---|
| 8B (Llama 3.1 8B, Qwen 7B) | 7–8B | ~5 GB | anything, incl. Jetson Orin Nano 8 GB — fast |
| ~27–49B (Qwen 27B, Nemotron Super) | 27–49B | ~17–30 GB | workstation GPU / Jetson AGX Orin 64 GB |
| 70B | 70B | ~40 GB | 64 GB+ unified memory; slow but usable |
| 253B (Nemotron Ultra) | 253B | ~130–150 GB | **too big for any Jetson, incl. AGX Thor 128 GB** |

The bot's job is to be a competent group-chat member, not a frontier model — a
27–49B local model is more than enough, and the entire point of going local is
privacy, not IQ.

## 4. Why not FHE (with citations)

FHE would let the model compute directly on ciphertext, preserving true E2EE.
It is not feasible for chat-sized models today, and the gap is enormous — not a
2–3 year gap.

- The only published ≥7B result that runs at all is **MPC (secret-sharing),
  not FHE**: PUMA (arXiv **2307.12533**, 2023) runs LLaMA-7B at **~5 minutes per
  token** — a single 200-token reply ≈ 16 hours.
- Pure-FHE demos top out at **BERT-class encoders (~110M params)** — e.g. THE-X
  (arXiv 2206.00216) — roughly 10³–10⁶× slower than plaintext, with no
  interactive decoder-LLM result anywhere.
- Progress since has been steady **constant-factor** wins (SecFormer
  2401.00793, Nimbus 2411.15707: single-digit× speedups on BERT), not the ~10⁵×
  *step* interactive 7B chat would require.

Two honest caveats:
1. Most fast "private inference" papers are **MPC assuming two non-colluding
   servers on a LAN.** For a single-provider deployment that non-collusion
   assumption does not hold and the latency claims do not survive WAN — they are
   not E2E-private against one operator the way FHE would be.
2. Several frequently-cited schemes (NEXUS, BOLT, BumbleBee, CipherGPT, Iron)
   are IACR-eprint/venue papers not verified in our arXiv survey; numbers above
   are only those we could confirm.

**Verdict:** FHE is a research-decade problem absent an algorithmic break or
dedicated FHE hardware. It stays a roadmap footnote; local inference is the
answer that ships.

## 5. Vault / local-knowledge awareness

Because the recommended deployment runs the model locally, the AI member can be
given access to a local knowledge base (e.g. an Obsidian vault) **without any
privacy tradeoff**: notes are retrieved on-device, injected into a local model's
context, and never cross the trust boundary. Set `AGENT_VAULT_PATH` to enable
it (default off). Retrieval is local keyword search over your markdown; the
retrieved snippets are background reference in the system prompt and are never
sent anywhere the messages themselves are not already going. With remote
inference this feature would ship your notes to the provider — so it is
intended for the local-inference deployment.

## 6. Roadmap

- **TEE confidential inference** — attested GPU enclaves (Apple PCC-style
  architecture; rentable H100/Blackwell confidential-mode services) so hosted
  inference can be offered without trusting the operator, verifiable by the
  client before any plaintext is sent.
- **P2P transport (Holepunch/Pears)** — replace the central relay with
  peer-to-peer transport (as Keet does), keeping libsignal as the E2EE layer on
  top. This removes the relay's metadata visibility; note it does not change the
  AI-plaintext story (an always-on peer — e.g. the Jetson — still hosts the AI
  and its local model). The elegant end state is a single self-hosted appliance
  that is both the always-on peer and the local inference host — no cloud at all.
- **FHE** — tracked, not planned; see §4.
