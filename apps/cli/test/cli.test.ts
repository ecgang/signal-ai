import { createHash, randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SignalAiClient } from "@signalai/client-sdk";
import { Identity } from "@signalai/core";
import type { SignalAgent } from "../../agent/src/index.js";
import { CliApp, AI_REMOVED_LINE } from "../src/app.js";
import { formatFingerprint } from "../src/render.js";
import { signupSession, loginSession, type CliSession } from "../src/session.js";
import type { CliConfig } from "../src/config.js";
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
  cleanupStateDirs,
  makeCliConfig,
  relayWsUrl,
  INVITE_CODE,
  INTRO_TEXT,
} from "./helpers.js";

/**
 * Phase 6B acceptance suite (§4b). Every criterion is proven by driving the
 * headless {@link CliApp} core directly — no PTY — against a REAL relay and a
 * REAL {@link SignalAgent} (mock-LLM). `handleInput` returns the synchronous
 * echo/command lines; async consequences (incoming messages, membership/mode
 * events, key-change warnings) accumulate in `app.emittedLines`, so both
 * streams are assertable deterministically via `waitUntil` (no sleeps).
 */

let harness: RelayHarness;
const sessions: CliSession[] = [];
const humans: SignalAiClient[] = [];
const agents: SignalAgent[] = [];

beforeAll(async () => {
  harness = await startRelay();
});

afterAll(async () => {
  await stopRelay(harness);
  cleanupTmpDbs();
  cleanupStateDirs();
});

beforeEach(async () => {
  await resetDb(harness.prisma);
});

afterEach(async () => {
  for (const a of agents.splice(0)) await a.shutdown().catch(() => undefined);
  for (const s of sessions.splice(0)) await s.close().catch(() => undefined);
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

interface BootedCli {
  app: CliApp;
  session: CliSession;
  config: CliConfig;
  username: string;
}

/** Signs up a fresh CLI account (durable sqlite state) and wraps it in a {@link CliApp}. */
async function bootCli(prefix: string, config = makeCliConfig(relayUrl())): Promise<BootedCli> {
  const username = uniqueUsername(prefix);
  const session = await signupSession({ config, username, inviteCode: INVITE_CODE });
  sessions.push(session);
  const app = CliApp.fromSession(session, config);
  return { app, session, config, username };
}

/** True once any emitted line contains `needle`. */
function sawLine(app: CliApp, needle: string): boolean {
  return app.emittedLines.some((l) => l.text.includes(needle));
}

/** Count of AI replies (mock-LLM) rendered in the stream — excludes the one-time intro. */
function agentReplyCount(app: CliApp): number {
  return app.emittedLines.filter((l) => l.kind === "message" && l.text.includes("mock-reply:")).length;
}

describe("@signalai/cli — Phase 6B acceptance (§4b)", () => {
  // -- 1 -------------------------------------------------------------------
  it("1. signup + login create and PERSIST an account (+ trust) against a local relay", async () => {
    const { session, config, username } = await bootCli("alice");
    const originalUserId = session.client.userId;

    const bob = track(await signupHuman(relayUrl(), uniqueUsername("bob")));
    const app = CliApp.fromSession(session, config);
    await app.handleInput("/new team");
    await app.handleInput(`/invite ${bob.username}`); // persists directory(bobUserId → "bob")
    const bobUserId = bob.userId;

    await session.close(); // flush both sqlite stores to disk
    sessions.splice(sessions.indexOf(session), 1);

    // login resumes the SAME account from disk (no key rotation)...
    const resumed = await loginSession({ config, username });
    sessions.push(resumed);
    expect(resumed.client.userId).toBe(originalUserId);
    expect(resumed.client.username).toBe(username);
    // ...and the CLI-local trust store survived the restart.
    expect(resumed.trustStore.getUsername(bobUserId)).toBe(bob.username);
  }, 30_000);

  // -- 2 -------------------------------------------------------------------
  it("2. group chat: create, invite two others, exchange messages, all rendered readably", async () => {
    const { app, username: aliceName } = await bootCli("alice");
    const bob = track(await signupHuman(relayUrl(), uniqueUsername("bob")));
    const carol = track(await signupHuman(relayUrl(), uniqueUsername("carol")));
    const bobMsgs = collectMessages(bob);
    const carolMsgs = collectMessages(carol);

    await app.handleInput("/new team");
    await app.handleInput(`/invite ${bob.username}`);
    await app.handleInput(`/invite ${carol.username}`);
    const conv = app.activeConversationId!;

    // Outgoing message is echoed optimistically as a readable line.
    const echo = await app.handleInput("hello everyone");
    expect(echo[0]!.kind).toBe("message");
    expect(echo[0]!.text).toMatch(/^\d\d:\d\d .*: hello everyone$/);

    // Both invited members receive it.
    await waitUntil(() => bobMsgs.some((m) => m.text === "hello everyone"));
    await waitUntil(() => carolMsgs.some((m) => m.text === "hello everyone"));

    // A peer reply is rendered readably in alice's stream, name resolved to the
    // invited username (not an opaque userId).
    await bob.resolveUser(aliceName);
    await bob.resolveUser(carol.username);
    await bob.send(conv, "hi from bob");
    // Rendered readably: HH:MM timestamp + the sender's resolved username + body.
    await waitUntil(() =>
      app.emittedLines.some(
        (l) => l.kind === "message" && /^\d\d:\d\d /.test(l.text) && l.text.endsWith(`${bob.username}: hi from bob`),
      ),
    );
  }, 30_000);

  // -- 3 & parity ----------------------------------------------------------
  it("3. /members shows fingerprints + role; AI labeled with current mode (+ fingerprint parity)", async () => {
    const { app, session } = await bootCli("alice");
    const booted = await bootAgent(relayUrl());
    agents.push(booted.agent);
    const bob = track(await signupHuman(relayUrl(), uniqueUsername("bob")));
    const bobUserId = bob.userId;

    await app.handleInput("/new team");
    await app.handleInput(`/invite ${bob.username}`);
    await app.handleInput(`/ai invite ${booted.agent.signalClient.username}`);
    const conv = app.activeConversationId!;

    // Establish sessions (so identity keys — hence fingerprints — become known).
    // `send` awaits ensureSession for every member, so keys are known on return.
    await app.handleInput("hi team");

    const membersOut = await app.handleInput("/members");
    const text = membersOut.map((l) => l.text).join("\n");
    // Every non-self member row carries a grouped 16-hex fingerprint + a role.
    expect(text).toMatch(/[0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4}/);
    expect(text).toMatch(/— (admin|member)/);
    // AI is labeled with its CURRENT mode (passive by default).
    expect(text).toContain("[AI · passive]");
    // Honest passive-mode note is present.
    expect(text.toLowerCase()).toContain("decrypts every message");

    // Fingerprint parity: the displayed fingerprint === sha256(identityKey).hex.slice(0,16).
    const members = await session.client.listMembers(conv);
    const bobMember = members.find((m) => m.userId === bobUserId)!;
    const bobId = bob.serializedIdentity;
    const expectedFp = createHash("sha256")
      .update(Identity.fromSerialized(bobId.identityKeyPair, bobId.registrationId).keyPair.publicKey.serialize())
      .digest("hex")
      .slice(0, 16);
    expect(bobMember.identityKeyFingerprint).toBe(expectedFp);
    expect(text).toContain(formatFingerprint(expectedFp));
  }, 30_000);

  // -- 4 -------------------------------------------------------------------
  it("4. /verify marks a member verified (persisted); verified indicator renders", async () => {
    const { app, session } = await bootCli("alice");
    const bob = track(await signupHuman(relayUrl(), uniqueUsername("bob")));
    const bobUserId = bob.userId;

    await app.handleInput("/new team");
    await app.handleInput(`/invite ${bob.username}`);
    const conv = app.activeConversationId!;
    await app.handleInput("establish a session please"); // exchange → bob's key becomes known

    const verifyOut = await app.handleInput(`/verify ${bob.username}`);
    expect(verifyOut.map((l) => l.text).join("\n")).toContain("marked verified");
    // Persisted in the trust store.
    expect(session.trustStore.getVerifiedFingerprint(conv, bobUserId)).toBeTruthy();
    // Indicator renders in /members.
    const membersOut = await app.handleInput("/members");
    expect(membersOut.some((l) => l.text.includes("bob") && l.text.includes("✓"))).toBe(true);
  }, 30_000);

  // -- 5 -------------------------------------------------------------------
  it("5. simulated peer identity-key change prints ⚠ in-stream AND resets verified state", async () => {
    const { app, session, username: aliceName } = await bootCli("alice");
    const bob = track(await signupHuman(relayUrl(), uniqueUsername("bob")));
    const bobUserId = bob.userId;

    await app.handleInput("/new team");
    await app.handleInput(`/invite ${bob.username}`);
    const conv = app.activeConversationId!;
    await app.handleInput("first contact"); // establish + learn bob's key
    await app.handleInput(`/verify ${bob.username}`);
    expect(session.trustStore.getVerifiedFingerprint(conv, bobUserId)).toBeTruthy();

    // Bob reinstalls: a NEW identity for the same relay account (the only way a
    // peer's key actually changes here). The new-identity envelope, on decrypt,
    // trips identityKeyChanged.
    bob.disconnect();
    const bob2 = track(
      await SignalAiClient.reregisterDevice({
        relayUrl: relayUrl(),
        userId: bob.userId,
        token: bob.token,
        username: bob.username,
      }),
    );
    await bob2.resolveUser(aliceName);
    await bob2.send(conv, "it is still me, new phone");

    await waitUntil(() => sawLine(app, "security fingerprint changed"));
    expect(app.emittedLines.some((l) => l.kind === "warn" && l.text.includes("⚠"))).toBe(true);
    // Verified state was reset — the recorded fingerprint no longer stands.
    expect(session.trustStore.getVerifiedFingerprint(conv, bobUserId)).toBeUndefined();
  }, 30_000);

  // -- 6 -------------------------------------------------------------------
  it("6. @ai mention triggers an agent reply (mock-LLM); reply renders in stream", async () => {
    const { app } = await bootCli("alice");
    const booted = await bootAgent(relayUrl());
    agents.push(booted.agent);

    await app.handleInput("/new team");
    await app.handleInput(`/ai invite ${booted.agent.signalClient.username}`);

    await app.handleInput("@ai hello there");
    await waitUntil(() => agentReplyCount(app) >= 1);
    expect(app.emittedLines.some((l) => l.kind === "message" && l.text.includes("mock-reply:"))).toBe(true);
  }, 30_000);

  // -- 7 -------------------------------------------------------------------
  it("7. /ai passive|active persists to relay and changes agent behavior (CLI-driven)", async () => {
    const { app } = await bootCli("alice");
    const booted = await bootAgent(relayUrl(), { configOverrides: { activeCapN: 2, reconcileIntervalMs: 200 } });
    agents.push(booted.agent);
    const { llm } = booted;

    await app.handleInput("/new team");
    await app.handleInput(`/ai invite ${booted.agent.signalClient.username}`);

    // First contact greeting (NOT an LLM call).
    await app.handleInput("warm up");
    await waitUntil(() => sawLine(app, INTRO_TEXT));

    // PASSIVE (default): a non-mention is ignored; the @ai barrier reply proves
    // the queue drained past it with ZERO extra LLM calls.
    await app.handleInput("just chatting, nobody addressed");
    await app.handleInput("@ai barrier one");
    await waitUntil(() => agentReplyCount(app) === 1);
    expect(llm.calls.length).toBe(1);

    // ACTIVE: exactly N non-mentions cross the unprompted cap ONCE.
    await app.handleInput("/ai active");
    await app.handleInput("unprompted one"); // counter 1 < 2
    await app.handleInput("unprompted two"); // counter 2 >= 2 → one unprompted reply
    await waitUntil(() => agentReplyCount(app) === 2);
    await new Promise((r) => setTimeout(r, 400)); // settle: prove it STAYS one (no runaway loop)
    expect(llm.calls.length).toBe(2);
    expect(agentReplyCount(app)).toBe(2);
  }, 45_000);

  // -- 8 -------------------------------------------------------------------
  it("8. system events (join/AI-invite/AI-remove/mode-change) render timestamped; AI-removal reassurance honest", async () => {
    const { app } = await bootCli("alice");
    const booted = await bootAgent(relayUrl());
    agents.push(booted.agent);
    const aiName = booted.agent.signalClient.username;
    const bob = track(await signupHuman(relayUrl(), uniqueUsername("bob")));

    // The shared system() renderer stamps EVERY system line `HH:MM · <text>`.
    // Assert that stamp explicitly for each of the four kinds, so it is proven
    // per-kind rather than inferred from the join case alone.
    const TS = /^\d\d:\d\d · /;

    await app.handleInput("/new team");

    // (join) a human joining renders a timestamped system line.
    await app.handleInput(`/invite ${bob.username}`);
    await waitUntil(() =>
      app.emittedLines.some((l) => l.kind === "system" && TS.test(l.text) && l.text.includes("joined")),
    );

    // (AI invite) the AI member's join renders a timestamped system line.
    await app.handleInput(`/ai invite ${aiName}`);
    await waitUntil(() =>
      app.emittedLines.some(
        (l) => l.kind === "system" && TS.test(l.text) && l.text.includes(aiName) && l.text.includes("joined"),
      ),
    );

    // (mode change / aiModeChanged) renders a timestamped system line.
    await app.handleInput("/ai active");
    await waitUntil(() =>
      app.emittedLines.some((l) => l.kind === "system" && /^\d\d:\d\d · AI mode changed to active$/.test(l.text)),
    );

    // (AI remove) the AI member's removal renders a timestamped system line...
    const removeOut = await app.handleInput("/ai remove");
    await waitUntil(() =>
      app.emittedLines.some(
        (l) => l.kind === "system" && TS.test(l.text) && l.text.includes(aiName) && l.text.includes("was removed"),
      ),
    );
    // ...alongside the exact honest reassurance line (Liotta): removal is real, not cosmetic.
    expect(removeOut.map((l) => l.text)).toContain(AI_REMOVED_LINE);
    expect(AI_REMOVED_LINE).toContain("not encrypted to it");
  }, 30_000);

  // -- 9 -------------------------------------------------------------------
  it("9. /remove shows the leave event; the RELAY refuses forged post-removal delivery to the removed party", async () => {
    const { app, session } = await bootCli("alice");
    const alice = session.client;
    const bob = track(await signupHuman(relayUrl(), uniqueUsername("bob")));
    const carol = track(await signupHuman(relayUrl(), uniqueUsername("carol")));
    const bobMsgs = collectMessages(bob);
    const carolMsgs = collectMessages(carol);

    await app.handleInput("/new team");
    await app.handleInput(`/invite ${bob.username}`);
    await app.handleInput(`/invite ${carol.username}`);
    const conv = app.activeConversationId!;

    await app.handleInput("everyone is here");
    await waitUntil(() => bobMsgs.some((m) => m.text === "everyone is here"));
    await waitUntil(() => carolMsgs.some((m) => m.text === "everyone is here"));

    // Remove bob → the leave event renders in alice's stream.
    await app.handleInput(`/remove ${bob.username}`);
    await waitUntil(() => sawLine(app, "was removed from the conversation"));

    // Caller-side skip: a normal send never targets bob (listMembers excludes
    // him); carol (still a member) receives it — the positive delivery is the
    // deterministic barrier. This ALONE, however, only proves alice's fanout
    // omitted bob — indistinguishable from a relay that would happily deliver.
    await app.handleInput("this is after the removal");
    await waitUntil(() => carolMsgs.some((m) => m.text === "this is after the removal"));
    expect(bobMsgs.some((m) => m.text === "this is after the removal")).toBe(false);

    // --- RELAY-SIDE refusal proof (mirrors packages/client-sdk/test/e2e.test.ts) ---
    // Forge, via alice's OWN retained pairwise session with bob, a REAL post-
    // removal ciphertext addressed to bob's session — one he WOULD decrypt if it
    // reached him — and push it with a raw WS `send` frame, bypassing
    // SignalAiClient.send()'s caller-side exclusion. Assert the relay refuses it
    // at BOTH delivery points (isActiveMember gate), the same shape e2e uses.
    const plaintext = { msgId: randomUUID(), text: "forged after removal", mentions: [], sentAt: Date.now() };
    const bytes = new TextEncoder().encode(JSON.stringify(plaintext));
    const [forgedForBob] = await alice.fanout.encryptForMembers(bytes, [{ userId: bob.userId, deviceId: bob.deviceId }], {
      conversationId: conv,
      senderUserId: alice.userId,
      senderDeviceId: alice.deviceId,
    });

    // (1) Live-push refusal — bob's socket has been open since signup, so a
    // regressed send-time guard would push this onto his live socket right now.
    bobMsgs.length = 0;
    await pushRawSendFrame(relayUrl(), alice.token, alice.deviceId, bob.userId, forgedForBob!);
    await new Promise((r) => setTimeout(r, 400)); // settle a full deliver→decrypt→onMessage, then assert nothing arrived
    expect(bobMsgs.filter((m) => m.conversationId === conv)).toHaveLength(0);

    // (2) Drain refusal — even across a fresh reconnect the drain never hands
    // bob the row that genuinely sits in the DB addressed to him.
    bob.disconnect();
    bobMsgs.length = 0;
    await bob.connect();
    await new Promise((r) => setTimeout(r, 400));
    expect(bobMsgs.filter((m) => m.conversationId === conv)).toHaveLength(0);

    // The forged row genuinely persisted (persistence guards only the SENDER),
    // so both refusals above are delivery-time, not "nothing was ever enqueued".
    const orphanRow = await harness.prisma.envelope.findFirst({
      where: { conversationId: conv, recipientUserId: bob.userId },
    });
    expect(orphanRow).not.toBeNull();
  }, 30_000);

  // -- 10 ------------------------------------------------------------------
  it("10. an invited member's CLI adopts the conversation on first message and can reply (no /new)", async () => {
    const alice = await bootCli("alice");
    const bob = await bootCli("bob");

    await alice.app.handleInput("/new team");
    await alice.app.handleInput(`/invite ${bob.username}`);

    // Bob never ran /new, so before hearing anything he has no active
    // conversation and an attempt to speak is refused (the pre-fix dead end).
    expect(bob.app.activeConversationId).toBeUndefined();
    const refused = await bob.app.handleInput("trying to talk before joining");
    expect(refused.some((l) => l.text.includes("no active conversation"))).toBe(true);

    // Alice speaks; bob's FIRST inbound message auto-adopts the conversation.
    await alice.app.handleInput("welcome bob");
    await waitUntil(() => sawLine(bob.app, "welcome bob"));
    expect(bob.app.activeConversationId).toBe(alice.app.activeConversationId);
    expect(sawLine(bob.app, "You joined a conversation")).toBe(true);

    // Now bob replies WITHOUT ever running /new, and alice receives it E2EE.
    await bob.app.handleInput("hi alice, got it");
    await waitUntil(() => sawLine(alice.app, "hi alice, got it"));
  }, 30_000);
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
