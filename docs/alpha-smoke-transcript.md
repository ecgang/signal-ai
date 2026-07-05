# signal-ai — v0.1 alpha prod smoke transcript

> Real end-to-end run against the **hosted** relay and the **deployed** AI
> member. Regenerate with the command below (invite codes are injected from
> the relay service's env — no secret values appear here or in the script).

```
railway run -s relay -- pnpm --filter @signalai/client-sdk exec tsx scripts/prod-smoke.mts
```

- **Relay:** https://relay-production-fe4c.up.railway.app
- **AI member:** @ai (NVIDIA NIM Nemotron `nvidia/llama-3.3-nemotron-super-49b-v1`)
- **Captured:** 2026-07-05 18:50:38Z

It proves, in order: two humans exchange E2EE messages; the AI member gives a
genuine LLM reply when @mentioned; `aiMode` toggles active; removing the AI
emits `memberRemoved` to every human; and after removal the AI produces **no**
further reply (transport-layer revocation).

```text
[2026-07-05 18:50:13Z] RELAY = https://relay-production-fe4c.up.railway.app
[2026-07-05 18:50:13Z] AI member handle = @ai
[2026-07-05 18:50:14Z] alice signed up (userId cmr85buc)
[2026-07-05 18:50:14Z] bob   signed up (userId cmr85bv1)
[2026-07-05 18:50:15Z] resolved AI member "ai" → userId cmr81ui4
[2026-07-05 18:50:15Z] resolved bob → cmr85bv1 (prekey bundle cached for fan-out)
[2026-07-05 18:50:15Z] alice created conversation cmr85bvy
[2026-07-05 18:50:15Z] alice invited bob
[2026-07-05 18:50:15Z] alice invited @ai
[2026-07-05 18:50:15Z] members (3): cmr81ui4, cmr85buc, cmr85bv1
[2026-07-05 18:50:16Z] alice → all: "@ai in one sentence, what does Signal's Double Ratchet give you?"
[2026-07-05 18:50:16Z] bob received alice's plaintext → human↔human E2EE OK
[2026-07-05 18:50:17Z] @ai → alice: "@friends: Double Ratchet gives **forward and backward secrecy**, meaning even if a key is compromised, only the specific messages sent with that key are at risk, not the entire conversation history."
[2026-07-05 18:50:17Z] GENUINE @ai reply received (real LLM, not canned)
[2026-07-05 18:50:17Z] aiMode → active (getAiMode=true); aiModeChanged(true) observed
[2026-07-05 18:50:18Z] aiMode → passive (restored)
[2026-07-05 18:50:18Z] @ai removed — memberRemoved(@ai) observed on BOTH alice and bob
[2026-07-05 18:50:18Z] alice → all (post-removal): "@ai are you still receiving our messages?"
[2026-07-05 18:50:18Z] waiting 20s to prove @ai produces NO post-removal reply...
[2026-07-05 18:50:38Z] REVOCATION PROVEN: @ai replies before=1, after=1 (silent after removal)
```

**RESULT: ALPHA_SMOKE_PASSED**
