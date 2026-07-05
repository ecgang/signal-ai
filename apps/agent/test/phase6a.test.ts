import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SignalAiClient } from "@signalai/client-sdk";
import { INTRO_TEXT, type SignalAgent } from "../src/index.js";
import {
  type RelayHarness,
  startRelay,
  stopRelay,
  resetDb,
  uniqueUsername,
  signupHuman,
  collectMessages,
  waitUntil,
  bootAgent,
  cleanupTmpDbs,
} from "./helpers.js";

/**
 * Phase 6A load-bearing proof (V-6A.2): a HUMAN's `setAiMode` toggle
 * verifiably changes the AI agent's behavior — with ZERO change to the agent's
 * behavior engine. The only new machinery is that `aiMode` now rides the
 * relay's members response, so the agent's EXISTING per-message reconcile
 * (`onMessage` → `reconcileConversation` → `listMembers`) refreshes the cached
 * mode the agent reads at agent.ts:275. The mode source here is strictly the
 * human's `setAiMode` — never the agent's config or its own client.
 *
 * Deterministic barriers only: a `@ai` mention (which always answers regardless
 * of mode) is used as a "the queue has drained past everything before me"
 * barrier. If a preceding NON-mention had triggered the LLM, `llm.calls` would
 * be higher than the exact count asserted the instant the mention's reply lands.
 */

let harness: RelayHarness;
const humans: SignalAiClient[] = [];
const agents: SignalAgent[] = [];

beforeAll(async () => {
  harness = await startRelay();
});

afterAll(async () => {
  await stopRelay(harness);
  cleanupTmpDbs();
});

beforeEach(async () => {
  await resetDb(harness.prisma);
});

afterEach(async () => {
  for (const a of agents.splice(0)) {
    await a.shutdown().catch(() => undefined);
  }
  for (const h of humans.splice(0)) {
    try {
      h.disconnect();
    } catch {
      /* already disconnected */
    }
  }
});

function relayUrl(): string {
  return harness.relayUrl;
}

function track(client: SignalAiClient): SignalAiClient {
  humans.push(client);
  return client;
}

function agentReplies(msgs: ReturnType<typeof collectMessages>, agentUserId: string): number {
  return msgs.filter((m) => m.senderUserId === agentUserId && m.text.startsWith("mock-reply:")).length;
}

describe("@signalai/agent — 6A human toggle drives agent behavior", () => {
  it("V-6A.2: human setAiMode flips agent passive→active→passive via the reconcile sweep", async () => {
    const N = 2;
    // Small cap + short sweep. The mode source is the HUMAN's setAiMode; the
    // agent's own client mode is NEVER touched here.
    const { agent, llm } = await bootAgent(relayUrl(), {
      configOverrides: { activeCapN: N, reconcileIntervalMs: 200 },
    });
    agents.push(agent);
    const agentUserId = agent.userId;

    const human = track(await signupHuman(relayUrl(), uniqueUsername("human")));
    expect((await human.resolveUser(agent.signalClient.username)).userId).toBe(agentUserId);
    // Conversation created PASSIVE (default) — the agent is passive from birth.
    const convId = await human.createConversation([agentUserId]);
    const humanMsgs = collectMessages(human);

    // Discovery: first contact greets once (intro is NOT an LLM call).
    await human.send(convId, "hello there");
    await waitUntil(() => humanMsgs.some((m) => m.senderUserId === agentUserId && m.text === INTRO_TEXT));

    // (a) PASSIVE: a non-mention message is ignored by the LLM. Proven
    // deterministically by the following @ai barrier: once its reply lands, the
    // non-mention before it has been fully processed. If it had triggered the
    // LLM, llm.calls would be 2 here, not 1.
    await human.send(convId, "just chatting, nobody addressed"); // non-mention, passive => silent
    await human.send(convId, "@ai barrier one"); // mention => always replies (also resets the cadence counter to 0)
    // Wait on the DELIVERED reply, not llm.calls (which flips the instant the LLM
    // is invoked, before send() fans the reply out to the human's socket).
    await waitUntil(() => agentReplies(humanMsgs, agentUserId) === 1);
    expect(llm.calls.length).toBe(1); // the non-mention produced ZERO llm calls
    expect(agentReplies(humanMsgs, agentUserId)).toBe(1);

    // (b) Human toggles ACTIVE. The counter is 0 (reset by the barrier reply),
    // so exactly N non-mention messages cross the unprompted cap ONCE.
    await human.setAiMode(convId, true);
    await human.send(convId, "unprompted one"); // counter 1 < N => no reply
    await human.send(convId, "unprompted two"); // counter 2 >= N => exactly one unprompted reply
    await waitUntil(() => agentReplies(humanMsgs, agentUserId) === 2);
    await new Promise((r) => setTimeout(r, 400)); // settle: prove it STAYS one reply (no runaway self-reply loop)
    expect(llm.calls.length).toBe(2);
    expect(agentReplies(humanMsgs, agentUserId)).toBe(2);

    // (c) Human toggles PASSIVE again. Even MORE than N non-mention messages now
    // trigger NOTHING. Proven deterministically by the final @ai barrier: when
    // its reply lands, llm.calls is exactly 3 — the three passive non-mentions
    // added ZERO calls.
    await human.setAiMode(convId, false);
    await human.send(convId, "post toggle one"); // counter 1
    await human.send(convId, "post toggle two"); // counter 2 — would have replied if still active
    await human.send(convId, "post toggle three"); // counter 3 — still silent in passive
    await human.send(convId, "@ai barrier two"); // mention => replies
    await waitUntil(() => agentReplies(humanMsgs, agentUserId) === 3);
    expect(llm.calls.length).toBe(3); // the three passive non-mentions produced ZERO llm calls
    expect(agentReplies(humanMsgs, agentUserId)).toBe(3);
  }, 40_000);
});
