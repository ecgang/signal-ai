import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { SignalAiClient } from "@signalai/client-sdk";
import { INTRO_TEXT, DEGRADE_TEXT, type SignalAgent } from "../src/index.js";
import { MockLlmClient, selectLlmClient } from "../src/llm.js";
import {
  type RelayHarness,
  startRelay,
  stopRelay,
  resetDb,
  uniqueUsername,
  signupHuman,
  collectMessages,
  waitUntil,
  relayWsUrl,
  bootAgent,
  cleanupTmpDbs,
} from "./helpers.js";

/**
 * End-to-end proof for `@signalai/agent`, the AI member. Every test drives a
 * REAL relay (real HTTP + WebSocket + Postgres + `@signalai/core` crypto) with
 * plain human {@link SignalAiClient}s on one side and a {@link SignalAgent}
 * wired to a {@link MockLlmClient} on the other — so the mode engine, the
 * per-conversation isolation invariant, and the removal purge are exercised
 * against the same wire a human uses, with zero network/keys in CI.
 *
 * These are the 10 named tests of spec 5B.7 (verbatim titles).
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
    await a.shutdown().catch(() => undefined); // idempotent-safe: a manually-shutdown agent (restart test) throws on re-close; swallow it
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

/** Registers a human client for afterEach cleanup. */
function track(client: SignalAiClient): SignalAiClient {
  humans.push(client);
  return client;
}

/**
 * The common opening move: a human resolves the agent by username (building
 * their pairwise session and learning the agent's userId), then opens a
 * conversation with just the agent in it. Returns everything a test needs.
 */
async function humanWithAgent(
  agentUsername: string,
  agentUserId: string,
): Promise<{ human: SignalAiClient; convId: string; humanMsgs: ReturnType<typeof collectMessages> }> {
  const human = track(await signupHuman(relayUrl(), uniqueUsername("human")));
  const resolved = await human.resolveUser(agentUsername);
  expect(resolved.userId).toBe(agentUserId);
  const convId = await human.createConversation([agentUserId]);
  const humanMsgs = collectMessages(human);
  return { human, convId, humanMsgs };
}

/** Count of messages a human received from the agent with an exact body. */
function countFrom(msgs: ReturnType<typeof collectMessages>, agentUserId: string, text: string): number {
  return msgs.filter((m) => m.senderUserId === agentUserId && m.text === text).length;
}

describe("@signalai/agent — 5B.7", () => {
  it("signs up via same public API as humans", async () => {
    const { agent, store } = await bootAgent(relayUrl());
    agents.push(agent);

    // Same signup path a human uses => discoverable by a human via resolveUser,
    // and its state was persisted at signup time (resume works on restart).
    const human = track(await signupHuman(relayUrl(), uniqueUsername("human")));
    const resolved = await human.resolveUser(agent.signalClient.username);
    expect(resolved.userId).toBe(agent.userId);
    expect(store.load()).not.toBeNull(); // signup persisted immediately (5B.2)
  }, 20_000);

  it("auto-join + intro on invite", async () => {
    const { agent } = await bootAgent(relayUrl());
    agents.push(agent);
    const agentUserId = agent.userId;
    const { human, convId, humanMsgs } = await humanWithAgent(agent.signalClient.username, agentUserId);

    // First human message => agent discovers the conversation and greets ONCE.
    await human.send(convId, "hey there");
    await waitUntil(() => countFrom(humanMsgs, agentUserId, INTRO_TEXT) === 1);

    // A mention gives us a deterministic barrier: once its reply lands, the
    // agent's serialized queue has fully processed everything before it — so if
    // the intro were going to fire twice, it already would have.
    await human.send(convId, "@ai barrier");
    await waitUntil(() => humanMsgs.some((m) => m.senderUserId === agentUserId && m.text.startsWith("mock-reply:")));
    expect(countFrom(humanMsgs, agentUserId, INTRO_TEXT)).toBe(1);
  }, 20_000);

  it("passive: ignores unmentioned, replies to @ai", async () => {
    const { agent, llm } = await bootAgent(relayUrl());
    agents.push(agent);
    const agentUserId = agent.userId;
    const { human, convId, humanMsgs } = await humanWithAgent(agent.signalClient.username, agentUserId);

    // Unmentioned in passive mode: intro fires, but the LLM is never consulted.
    await human.send(convId, "just chatting, no mention here");
    await waitUntil(() => countFrom(humanMsgs, agentUserId, INTRO_TEXT) === 1);
    expect(llm.calls.length).toBe(0);

    // A direct @ai mention always answers. Wait on the DELIVERED reply (not on
    // llm.calls, which flips the instant the LLM is invoked — before send()
    // fans the reply out and the human's socket decrypts it).
    await human.send(convId, "hey @ai can you help");
    await waitUntil(() => humanMsgs.some((m) => m.senderUserId === agentUserId && m.text.startsWith("mock-reply:")));
    expect(llm.calls.length).toBe(1);
  }, 20_000);

  it("active: unprompted replies capped by N; never self-replies", async () => {
    const N = 3;
    const { agent, llm } = await bootAgent(relayUrl(), { configOverrides: { activeCapN: N } });
    agents.push(agent);
    const agentUserId = agent.userId;
    const { human, convId, humanMsgs } = await humanWithAgent(agent.signalClient.username, agentUserId);

    // Discover the conversation, then flip the agent's OWN client to active mode.
    await human.send(convId, "m1");
    await waitUntil(() => countFrom(humanMsgs, agentUserId, INTRO_TEXT) === 1);
    await agent.signalClient.setAiMode(convId, true);

    // Six unmentioned human messages total => unprompted replies at the 3rd and
    // 6th (counter resets on each reply). If the agent ever answered its own
    // output, this count would run away instead of stopping at 2.
    for (const body of ["m2", "m3", "m4", "m5", "m6"]) {
      await human.send(convId, body);
    }
    await waitUntil(() => llm.calls.length === 2);
    await new Promise((r) => setTimeout(r, 400)); // settle: prove it STAYS at 2 (no self-reply loop)
    expect(llm.calls.length).toBe(2);

    const agentReplies = humanMsgs.filter((m) => m.senderUserId === agentUserId && m.text.startsWith("mock-reply:"));
    expect(agentReplies).toHaveLength(2);
  }, 30_000);

  it("hot mode-switch mid-conversation changes behavior", async () => {
    const { agent, llm } = await bootAgent(relayUrl(), { configOverrides: { activeCapN: 1 } });
    agents.push(agent);
    const agentUserId = agent.userId;
    const { human, convId, humanMsgs } = await humanWithAgent(agent.signalClient.username, agentUserId);

    await human.send(convId, "hi");
    await waitUntil(() => countFrom(humanMsgs, agentUserId, INTRO_TEXT) === 1);

    // Passive: an unmentioned message is ignored by the LLM.
    await human.send(convId, "anyone around");
    await new Promise((r) => setTimeout(r, 500)); // settle: passive => no LLM call
    expect(llm.calls.length).toBe(0);

    // Flip to active; now the same kind of unmentioned message triggers a
    // reply. Wait on the DELIVERED reply (not on llm.calls, which flips before
    // send() reaches the human's socket).
    await agent.signalClient.setAiMode(convId, true);
    await human.send(convId, "still nobody mentioned me");
    await waitUntil(() => humanMsgs.some((m) => m.senderUserId === agentUserId && m.text.startsWith("mock-reply:")));
    expect(llm.calls.length).toBe(1);
  }, 20_000);

  it("restart persistence: context survives via sqlite", async () => {
    const first = await bootAgent(relayUrl());
    agents.push(first.agent);
    const agentUserId = first.agent.userId;
    const agentUsername = first.agent.signalClient.username;
    const { human, convId } = await humanWithAgent(agentUsername, agentUserId);

    await human.send(convId, "@ai please remember the number 42");
    await waitUntil(() => first.llm.calls.length === 1);

    // Restart: shut the first process down (persist + close), boot a fresh
    // process + fresh MockLlmClient against the SAME sqlite file.
    await first.agent.shutdown();
    const second = await bootAgent(relayUrl(), { config: first.config });
    agents.push(second.agent);
    expect(second.agent.userId).toBe(agentUserId); // resumed, not a new signup

    await human.send(convId, "@ai what number should you recall");
    await waitUntil(() => second.llm.calls.length === 1);

    // The reply after restart was built from a window that includes the
    // PRE-restart turn — proving context was loaded from sqlite, not memory.
    const transcript = second.llm.calls[0]!.messages;
    expect(transcript.some((m) => m.content.includes("remember the number 42"))).toBe(true);
  }, 30_000);

  it("intro is not re-sent after restart", async () => {
    const first = await bootAgent(relayUrl());
    agents.push(first.agent);
    const agentUserId = first.agent.userId;
    const agentUsername = first.agent.signalClient.username;
    const { human, convId, humanMsgs } = await humanWithAgent(agentUsername, agentUserId);

    // First contact => intro fires exactly once (the greeted flag is persisted
    // to conversation_meta).
    await human.send(convId, "hello");
    await waitUntil(() => countFrom(humanMsgs, agentUserId, INTRO_TEXT) === 1);

    // Restart against the SAME sqlite file. boot()'s reconcileAll re-checks the
    // resumed conversation, but the persisted greeted flag must suppress a
    // second intro.
    await first.agent.shutdown();
    const second = await bootAgent(relayUrl(), { config: first.config });
    agents.push(second.agent);
    expect(second.agent.userId).toBe(agentUserId); // resumed, not a new signup

    // A mention gives a deterministic barrier: once its reply lands, boot()'s
    // reconcile (and any re-greet it might have done) has fully processed.
    await human.send(convId, "@ai barrier");
    await waitUntil(() => humanMsgs.some((m) => m.senderUserId === agentUserId && m.text.startsWith("mock-reply:")));

    // Exactly one intro across BOTH boots — never re-sent on restart.
    expect(countFrom(humanMsgs, agentUserId, INTRO_TEXT)).toBe(1);
  }, 30_000);

  it("removal purges context + post-removal traffic undecryptable", async () => {
    // Short sweep interval so the AUTONOMOUS reconciliation timer — not a manual
    // reconcile() — is what detects the removal within the test window.
    const { agent, store } = await bootAgent(relayUrl(), {
      llm: new MockLlmClient(),
      configOverrides: { reconcileIntervalMs: 200 },
    });
    agents.push(agent);
    const agentUserId = agent.userId;
    const agentDeviceId = agent.signalClient.deviceId;
    const { human, convId } = await humanWithAgent(agent.signalClient.username, agentUserId);

    await human.send(convId, "@ai hello there");
    await waitUntil(() => store.loadContext(convId).length > 0); // agent has real context for this conversation
    expect(agent.signalClient.stores.conversations.has(convId)).toBe(true);

    // Remove the agent. In a live process the removed agent gets NO further
    // messages and the SDK suppresses `memberRemoved` for its OWN removal, so
    // the ONLY autonomous discovery path is the periodic reconciliation sweep
    // (a 403/absence from listMembers is how self-removal is detected). We do
    // NOT call agent.reconcile() — the sweep must detect the removal on its own.
    await human.removeMember(convId, agentUserId);

    // (5B.5) The sweep purges autonomously: context window gone, local
    // conversation cache dropped — with no manual reconcile.
    await waitUntil(
      () => store.loadContext(convId).length === 0 && !agent.signalClient.stores.conversations.has(convId),
    );
    expect(store.loadContext(convId)).toHaveLength(0);
    expect(agent.signalClient.stores.conversations.has(convId)).toBe(false);

    // Post-removal traffic is undecryptable IN PRACTICE via a TRANSPORT-layer
    // guarantee, NOT by destroying key material: the removed agent's pairwise
    // Double-Ratchet session is intentionally RETAINED — it's keyed by peer
    // identity+device and SHARED across every conversation with that peer, so
    // deleting it would corrupt unrelated conversations (core exposes no
    // session-delete API by design; see packages/core/src/group.ts). Revocation
    // is enforced by (a) senders ceasing fan-out to the removed member and
    // (b) the relay's phase-4 two-gate refusing both live-push and
    // reconnect-drain. We forge a REAL ciphertext addressed to the agent's own
    // still-valid session (it WOULD decrypt if it ever reached the client —
    // which is what makes "nothing arrived" non-vacuous) and prove the
    // send-time live-push gate refuses it; the reconnect-drain gate is proven
    // exhaustively at the SDK layer in client-sdk/test/e2e.test.ts.
    const plaintext = { msgId: randomUUID(), text: "post-removal probe", mentions: [], sentAt: Date.now() };
    const bytes = new TextEncoder().encode(JSON.stringify(plaintext));
    const [forged] = await human.fanout.encryptForMembers(bytes, [{ userId: agentUserId, deviceId: agentDeviceId }], {
      conversationId: convId,
      senderUserId: human.userId,
      senderDeviceId: human.deviceId,
    });

    const agentInbox = collectMessages(agent.signalClient); // capture any post-removal arrival for convId
    await pushRawSendFrame(relayUrl(), human.token, human.deviceId, agentUserId, forged);
    await new Promise((r) => setTimeout(r, 400)); // settle a possible deliver->decrypt->onMessage before asserting nothing arrived
    expect(agentInbox.filter((m) => m.conversationId === convId)).toHaveLength(0);

    // The row genuinely exists (proves this is a real delivery-refusal, not
    // "nothing was ever enqueued").
    const orphanRow = await harness.prisma.envelope.findFirst({
      where: { conversationId: convId, recipientUserId: agentUserId },
    });
    expect(orphanRow).not.toBeNull();
  }, 30_000);

  it("cross-conversation isolation", async () => {
    const { agent, llm } = await bootAgent(relayUrl());
    agents.push(agent);
    const agentUserId = agent.userId;

    const human = track(await signupHuman(relayUrl(), uniqueUsername("human")));
    expect((await human.resolveUser(agent.signalClient.username)).userId).toBe(agentUserId);
    const convA = await human.createConversation([agentUserId]);
    const convB = await human.createConversation([agentUserId]);

    await human.send(convA, "@ai the secret word for A is ALPHA");
    await human.send(convB, "@ai the secret word for B is BRAVO");
    await waitUntil(() => llm.calls.length === 2);

    const callA = llm.calls.find((c) => c.messages.at(-1)?.content.includes("ALPHA"));
    const callB = llm.calls.find((c) => c.messages.at(-1)?.content.includes("BRAVO"));
    expect(callA, "expected a reply prompt containing ALPHA").toBeDefined();
    expect(callB, "expected a reply prompt containing BRAVO").toBeDefined();

    // Hard invariant (Linus BLOCKER 3): conversation A's prompt contains ZERO
    // content from conversation B, and vice versa.
    expect(JSON.stringify(callA!.messages)).not.toContain("BRAVO");
    expect(JSON.stringify(callB!.messages)).not.toContain("ALPHA");
  }, 30_000);

  it("provider swap", async () => {
    // The factory maps AGENT_PROVIDER to a concrete provider, defaults to
    // openai-compatible, and refuses an unknown one.
    expect(selectLlmClient({ AGENT_PROVIDER: "mock" }).provider).toBe("mock");
    expect(selectLlmClient({ AGENT_PROVIDER: "anthropic" }).provider).toBe("anthropic");
    expect(selectLlmClient({ AGENT_PROVIDER: "openai-compatible" }).provider).toBe("openai-compatible");
    expect(selectLlmClient({}).provider).toBe("openai-compatible");
    expect(() => selectLlmClient({ AGENT_PROVIDER: "does-not-exist" })).toThrow();

    // The agent is provider-agnostic: it uses whatever LlmClient is injected.
    const swapped = new MockLlmClient(() => "SWAPPED-PROVIDER-REPLY");
    const { agent } = await bootAgent(relayUrl(), { llm: swapped });
    agents.push(agent);
    const agentUserId = agent.userId;
    const { human, convId, humanMsgs } = await humanWithAgent(agent.signalClient.username, agentUserId);

    await human.send(convId, "@ai hello");
    await waitUntil(() => humanMsgs.some((m) => m.senderUserId === agentUserId && m.text === "SWAPPED-PROVIDER-REPLY"));
  }, 20_000);

  it("LLM failure degrades gracefully", async () => {
    const failing = new MockLlmClient();
    failing.fail = true;
    const { agent } = await bootAgent(relayUrl(), { llm: failing });
    agents.push(agent);
    const agentUserId = agent.userId;
    const { human, convId, humanMsgs } = await humanWithAgent(agent.signalClient.username, agentUserId);

    await human.send(convId, "@ai please help");
    await waitUntil(() => countFrom(humanMsgs, agentUserId, DEGRADE_TEXT) === 1);

    // A second failing attempt within the cooldown must NOT produce a second
    // apology. `failing.calls.length === 2` is the deterministic barrier: the
    // mock records the attempt before it throws, so once it's 2 both messages
    // have been fully processed.
    await human.send(convId, "@ai still there");
    await waitUntil(() => failing.calls.length === 2);
    await new Promise((r) => setTimeout(r, 200));
    expect(countFrom(humanMsgs, agentUserId, DEGRADE_TEXT)).toBe(1);
  }, 20_000);

  // Conditional live smoke: only when explicitly opted in with a real key set.
  // Skipped in CI (no network/keys), per 5B.7.
  it.skipIf(process.env.AGENT_LIVE_SMOKE !== "1")(
    "live smoke: the selected real provider returns a non-empty completion",
    async () => {
      const llm = selectLlmClient(process.env);
      const out = await llm.complete({
        system: "You are a terse test bot.",
        messages: [{ role: "user", content: "Reply with the single word: pong" }],
      });
      expect(typeof out).toBe("string");
      expect(out.length).toBeGreaterThan(0);
    },
    30_000,
  );
});

/** Opens a raw, one-shot authenticated WS connection and submits a single `send` frame, bypassing SignalAiClient entirely. */
async function pushRawSendFrame(
  relayHttpUrl: string,
  token: string,
  deviceId: number,
  recipientUserId: string,
  envelope: unknown,
): Promise<void> {
  const ws = new WebSocket(relayWsUrl(relayHttpUrl));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => {
      ws.send(JSON.stringify({ type: "auth", token, deviceId }));
    });
    ws.once("error", reject);
    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as { type: string };
      if (msg.type === "ready") {
        ws.send(JSON.stringify({ type: "send", recipientUserId, envelope }));
        resolve();
      }
    });
  });
  await new Promise((r) => setTimeout(r, 150)); // let the relay persist the row before we close
  ws.close();
}
