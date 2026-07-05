import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { PlaintextMessage, Envelope } from "@signalai/proto";
import { SignalAiClient, createHttpWsTransport } from "../src/index.js";
import {
  type RelayHarness,
  startRelay,
  stopRelay,
  resetDb,
  uniqueUsername,
  signupClient,
  collectMessages,
  collectEvents,
  waitUntil,
  relayWsUrl,
} from "./helpers.js";

/**
 * Full end-to-end proof for @signalai/client-sdk: real relay (real HTTP +
 * real WebSocket, not fastify.inject()) + real Postgres + real
 * @signalai/core crypto, driven entirely through SignalAiClient's public
 * API. The headline property is REMOVAL: a removed member can neither
 * decrypt another member's post-removal traffic nor have it drained to her
 * by the relay.
 */

let harness: RelayHarness;

beforeAll(async () => {
  harness = await startRelay();
});

afterAll(async () => {
  await stopRelay(harness);
});

beforeEach(async () => {
  await resetDb(harness.prisma);
});

function relayUrl(): string {
  return harness.relayUrl;
}

describe("golden: 3-party conversation", () => {
  it("all three parties exchange >=6 crossing messages and every one decrypts correctly", async () => {
    const alice = await signupClient(relayUrl(), uniqueUsername("alice"));
    const bob = await signupClient(relayUrl(), uniqueUsername("bob"));
    const carol = await signupClient(relayUrl(), uniqueUsername("carol"));

    const aliceMsgs = collectMessages(alice);
    const bobMsgs = collectMessages(bob);
    const carolMsgs = collectMessages(carol);

    // Contacts model: everyone resolves everyone else by username before messaging (see client.ts doc comment).
    await Promise.all([
      alice.resolveUser(bob.username),
      alice.resolveUser(carol.username),
      bob.resolveUser(alice.username),
      bob.resolveUser(carol.username),
      carol.resolveUser(alice.username),
      carol.resolveUser(bob.username),
    ]);

    const convId = await alice.createConversation([bob.userId, carol.userId]);
    // Bob/Carol learn the conversationId out-of-band (as they would from an
    // invite notification in a full app) and pull membership immediately.
    await bob.listMembers(convId);
    await carol.listMembers(convId);

    const sent: Array<{ from: string; msgId: string; text: string }> = [];
    async function crossSend(sender: SignalAiClient, text: string): Promise<void> {
      const msgId = await sender.send(convId, text);
      sent.push({ from: sender.userId, msgId, text });
    }

    await crossSend(alice, "hello from alice");
    await crossSend(bob, "hi alice, hi carol");
    await crossSend(carol, "hey everyone");
    await crossSend(alice, "how's it going");
    await crossSend(bob, "great, thanks");
    await crossSend(carol, "likewise!");

    expect(sent.length).toBeGreaterThanOrEqual(6);

    // Every message must land in the two inboxes that are not its own sender.
    try {
      await waitUntil(
        () =>
          aliceMsgs.filter((m) => m.senderUserId !== alice.userId).length >= 4 &&
          bobMsgs.filter((m) => m.senderUserId !== bob.userId).length >= 4 &&
          carolMsgs.filter((m) => m.senderUserId !== carol.userId).length >= 4,
        10_000,
      );
    } catch (e) {
      const tag = (u) => (u === alice.userId ? "A" : u === bob.userId ? "B" : u === carol.userId ? "C" : "?");
      console.log("GDUMP A_inbox=" + JSON.stringify(aliceMsgs.map((m) => tag(m.senderUserId) + ":" + m.text)));
      console.log("GDUMP B_inbox=" + JSON.stringify(bobMsgs.map((m) => tag(m.senderUserId) + ":" + m.text)));
      console.log("GDUMP C_inbox=" + JSON.stringify(carolMsgs.map((m) => tag(m.senderUserId) + ":" + m.text)));
      throw e;
    }

    for (const s of sent) {
      const inboxes: Array<[string, typeof aliceMsgs]> = [
        [alice.userId, aliceMsgs],
        [bob.userId, bobMsgs],
        [carol.userId, carolMsgs],
      ];
      for (const [userId, inbox] of inboxes) {
        if (userId === s.from) continue;
        const received = inbox.find((m) => m.msgId === s.msgId);
        expect(received, `expected ${userId} to receive msgId ${s.msgId} ("${s.text}")`).toBeDefined();
        expect(received!.text).toBe(s.text);
        expect(received!.senderUserId).toBe(s.from);
      }
    }

    // listMembers: fingerprints are non-empty for peers (sessions are now established both ways); self is always "".
    const membersForAlice = await alice.listMembers(convId);
    expect(membersForAlice).toHaveLength(3);
    for (const m of membersForAlice) {
      if (m.userId === alice.userId) continue;
      expect(m.identityKeyFingerprint.length).toBeGreaterThan(0);
    }

    alice.disconnect();
    bob.disconnect();
    carol.disconnect();
  }, 20_000);
});

describe("removal revokes access (headline)", () => {
  it("removed member cannot decrypt another member's post-removal ciphertext, and the relay refuses her drain", async () => {
    const alice = await signupClient(relayUrl(), uniqueUsername("alice"));
    const bob = await signupClient(relayUrl(), uniqueUsername("bob"));
    const carol = await signupClient(relayUrl(), uniqueUsername("carol"));

    const bobMsgs = collectMessages(bob);
    const carolMsgs = collectMessages(carol);

    await alice.resolveUser(bob.username);
    await alice.resolveUser(carol.username);
    await bob.resolveUser(alice.username);

    const convId = await alice.createConversation([bob.userId, carol.userId]);
    await bob.listMembers(convId);
    await carol.listMembers(convId);

    // Pre-removal traffic so Carol has real, decryptable history in this conversation.
    await alice.send(convId, "before removal, everyone");
    await waitUntil(() => bobMsgs.length >= 1 && carolMsgs.length >= 1);

    await alice.removeMember(convId, carol.userId);

    const membersAfterRemoval = await alice.listMembers(convId);
    expect(membersAfterRemoval.some((m) => m.userId === carol.userId)).toBe(false);

    bobMsgs.length = 0;
    const postRemovalMsgId = await alice.send(convId, "after removal, bob only");
    await waitUntil(() => bobMsgs.length === 1);
    expect(bobMsgs[0]!.msgId).toBe(postRemovalMsgId);
    expect(bobMsgs[0]!.text).toBe("after removal, bob only");

    // --- Crypto-layer proof -------------------------------------------------
    // Construct (via alice's own fanout — the exact envelope her `send()` just
    // produced for Bob is equivalent to this) a post-removal envelope
    // addressed to Bob's independent pairwise session, and assert Carol's own
    // fanout cannot decrypt it: her session state is bound to her OWN ratchet
    // with Alice, not Bob's.
    const plaintext: PlaintextMessage = { msgId: randomUUID(), text: "bob-only, again", mentions: [], sentAt: Date.now() };
    const bytes = new TextEncoder().encode(JSON.stringify(plaintext));
    const [postRemovalEnvelopeForBob] = await alice.fanout.encryptForMembers(bytes, [{ userId: bob.userId, deviceId: bob.deviceId }], {
      conversationId: convId,
      senderUserId: alice.userId,
      senderDeviceId: alice.deviceId,
    });
    await expect(carol.fanout.decryptEnvelope(postRemovalEnvelopeForBob!)).rejects.toThrow();

    // --- Relay-layer proof ---------------------------------------------------
    // Force-enqueue an envelope addressed to Carol AFTER her removal, via a
    // raw WS frame (bypassing SignalAiClient.send(), which would never target
    // her once listMembers excludes her). This forged envelope is a REAL
    // ciphertext addressed to Carol's OWN pairwise session with Alice, so if it
    // ever reached her client she WOULD decrypt it — that is what makes the
    // "she received nothing" assertions below non-vacuous.
    //
    // The relay enforces removal at TWO independent delivery points, and this
    // test now exercises BOTH:
    //   (1) send-time live-push (index.ts `liveSockets`) — guarded by
    //       isActiveMember(); asserted while Carol is STILL connected.
    //   (2) reconnect drain (listActiveConversationIds, removedAt: null) —
    //       asserted after a fresh reconnect.
    // Persistence itself is deliberately NOT recipient-guarded (the enqueue only
    // checks the SENDER, Alice, is a member), so the row genuinely lands in the
    // DB — proven by orphanRow below. Both delivery paths, not the write, are
    // where removal is enforced.
    const forgedForCarol = await alice.fanout.encryptForMembers(bytes, [{ userId: carol.userId, deviceId: carol.deviceId }], {
      conversationId: convId,
      senderUserId: alice.userId,
      senderDeviceId: alice.deviceId,
    });

    // Clear Carol's PRE-removal history (the "before removal, everyone" she
    // legitimately received at line ~144) so the live-push assertion below
    // measures ONLY what the relay pushes to her live socket AFTER removal.
    // The post-removal real send() above never targeted her (caller-side
    // listMembers exclusion), so with the guard intact this stays empty.
    carolMsgs.length = 0;
    await pushRawSendFrame(relayUrl(), alice.token, alice.deviceId, carol.userId, forgedForCarol[0]!);

    // (1) Live-push refusal — Carol's socket has been open since signup, so a
    // regressed send-time guard (`if (target)` instead of
    // `if (target && (await isActiveMember(...)))`) would push this envelope
    // onto her live socket right now. Settle long enough for an in-process
    // deliver → decrypt → onMessage to complete, then assert nothing arrived,
    // BEFORE we disconnect or clear the buffer. (A previous version cleared the
    // buffer first and so never actually exercised this path.)
    await new Promise((r) => setTimeout(r, 400));
    expect(carolMsgs.filter((m) => m.conversationId === convId)).toHaveLength(0);

    // (2) Drain refusal — even across a fresh reconnect, the drain never hands
    // Carol the row that genuinely sits in the DB addressed to her.
    carol.disconnect();
    carolMsgs.length = 0;
    await carol.connect();
    await new Promise((r) => setTimeout(r, 400)); // settle: prove nothing arrives, not a race against a message that hasn't landed yet
    expect(carolMsgs.filter((m) => m.conversationId === convId)).toHaveLength(0);

    const orphanRow = await harness.prisma.envelope.findFirst({ where: { conversationId: convId, recipientUserId: carol.userId } });
    expect(orphanRow).not.toBeNull(); // the row genuinely exists (proves this is a real drain-refusal, not "nothing was ever enqueued")

    alice.disconnect();
    bob.disconnect();
    carol.disconnect();
  }, 20_000);
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

describe("late-join", () => {
  it("a member invited mid-conversation decrypts only post-join traffic", async () => {
    const alice = await signupClient(relayUrl(), uniqueUsername("alice"));
    const bob = await signupClient(relayUrl(), uniqueUsername("bob"));
    const carol = await signupClient(relayUrl(), uniqueUsername("carol"));

    const bobMsgs = collectMessages(bob);
    const carolMsgs = collectMessages(carol);

    await alice.resolveUser(bob.username);
    await bob.resolveUser(alice.username);

    const convId = await alice.createConversation([bob.userId]);
    await bob.listMembers(convId);

    let preJoinEnvelope: Envelope | undefined;
    for (let i = 0; i < 5; i++) {
      const text = `pre-join message ${i}`;
      const msgId = await alice.send(convId, text);
      if (i === 4) {
        // Capture an equivalent pre-join envelope (same session state at this point) for the negative assertion below.
        const plaintext: PlaintextMessage = { msgId, text, mentions: [], sentAt: Date.now() };
        const bytes = new TextEncoder().encode(JSON.stringify(plaintext));
        [preJoinEnvelope] = await alice.fanout.encryptForMembers(bytes, [{ userId: bob.userId, deviceId: bob.deviceId }], {
          conversationId: convId,
          senderUserId: alice.userId,
          senderDeviceId: alice.deviceId,
        });
      }
    }
    await waitUntil(() => bobMsgs.length === 5);

    // Carol is invited late; alice/bob must resolve her (learn her username) before they can address her.
    await alice.invite(convId, carol.userId);
    await alice.resolveUser(carol.username);
    await bob.resolveUser(carol.username);
    await carol.listMembers(convId);

    // Carol has no session with Alice at all yet — a pre-join envelope (or any envelope from an unknown sender) must fail to decrypt.
    await expect(carol.fanout.decryptEnvelope(preJoinEnvelope!)).rejects.toThrow();

    const postJoinMsgId = await alice.send(convId, "welcome carol");
    await waitUntil(() => carolMsgs.length === 1 && bobMsgs.length === 6);
    expect(carolMsgs[0]!.msgId).toBe(postJoinMsgId);
    expect(carolMsgs[0]!.text).toBe("welcome carol");

    alice.disconnect();
    bob.disconnect();
    carol.disconnect();
  }, 20_000);
});

describe("offline delivery + ack", () => {
  it("drains all pending messages in order on reconnect, and acking deletes them", async () => {
    const alice = await signupClient(relayUrl(), uniqueUsername("alice"));
    const bob = await signupClient(relayUrl(), uniqueUsername("bob"));

    await alice.resolveUser(bob.username);
    await bob.resolveUser(alice.username); // establishes bob's outbound session too, though he won't send here

    const convId = await alice.createConversation([bob.userId]);
    await bob.listMembers(convId);

    bob.disconnect();
    await new Promise((r) => setTimeout(r, 100));

    const ids = [await alice.send(convId, "one"), await alice.send(convId, "two"), await alice.send(convId, "three")];

    await waitUntil(async () => {
      const count = await harness.prisma.envelope.count({ where: { recipientUserId: bob.userId } });
      return count === 3;
    });

    const bobMsgs = collectMessages(bob);
    await bob.connect();
    await waitUntil(() => bobMsgs.length === 3);

    expect(bobMsgs.map((m) => m.msgId)).toEqual(ids);
    expect(bobMsgs.map((m) => m.text)).toEqual(["one", "two", "three"]);

    await waitUntil(async () => (await harness.prisma.envelope.count({ where: { recipientUserId: bob.userId } })) === 0);

    alice.disconnect();
    bob.disconnect();
  }, 20_000);
});

describe("de-dup", () => {
  it("a resend sharing the same msgId is decrypted but does not double-fire onMessage", async () => {
    const alice = await signupClient(relayUrl(), uniqueUsername("alice"));
    const bob = await signupClient(relayUrl(), uniqueUsername("bob"));

    await alice.resolveUser(bob.username);
    const convId = await alice.createConversation([bob.userId]);
    await bob.listMembers(convId);

    const bobMsgs = collectMessages(bob);
    const plaintext: PlaintextMessage = { msgId: randomUUID(), text: "resend me", mentions: [], sentAt: Date.now() };

    // Two independent, both-legitimately-decryptable ciphertexts (fresh ratchet step each time) carrying the SAME msgId — simulating an app-level retry/resend.
    await alice.sendRaw(convId, plaintext);
    await alice.sendRaw(convId, plaintext);

    await waitUntil(() => bobMsgs.filter((m) => m.msgId === plaintext.msgId).length >= 1);
    await new Promise((r) => setTimeout(r, 300)); // settle: prove no second onMessage fires, not a race
    expect(bobMsgs.filter((m) => m.msgId === plaintext.msgId)).toHaveLength(1);

    // Both copies must still have been acked (deleted), even though only one was surfaced to the app.
    await waitUntil(async () => (await harness.prisma.envelope.count({ where: { recipientUserId: bob.userId } })) === 0);

    alice.disconnect();
    bob.disconnect();
  }, 20_000);
});

describe("sender authenticity", () => {
  it("a forged senderUserId is rejected by decrypt (picked session, not the relay-carried field)", async () => {
    const alice = await signupClient(relayUrl(), uniqueUsername("alice"));
    const bob = await signupClient(relayUrl(), uniqueUsername("bob"));
    const mallory = await signupClient(relayUrl(), uniqueUsername("mallory"));

    const bobMsgs = collectMessages(bob);

    // Both Alice and Mallory establish REAL, USED sessions with Bob (a first
    // message each way, decrypted by Bob) — the sender-authenticity property
    // only bites once Bob holds an independent, already-advanced ratchet for
    // the claimed sender; a still-unused (first-contact) session for that
    // address doesn't exercise it (see the doc comment on GroupFanout).
    const alicePlainConvId = await alice.createConversation([bob.userId]);
    await alice.resolveUser(bob.username);
    await bob.listMembers(alicePlainConvId);
    await alice.send(alicePlainConvId, "hi bob, it's alice");
    await waitUntil(() => bobMsgs.length === 1);

    const malloryPlainConvId = await mallory.createConversation([bob.userId]);
    await mallory.resolveUser(bob.username);
    await bob.listMembers(malloryPlainConvId);
    await mallory.send(malloryPlainConvId, "hi bob, it's mallory");
    await waitUntil(() => bobMsgs.length === 2);
    bobMsgs.length = 0;

    // Mallory's SECOND message to Bob: a real, validly-decryptable Whisper
    // ciphertext advancing HER session with Bob.
    const plaintext: PlaintextMessage = { msgId: randomUUID(), text: "impersonation attempt", mentions: [], sentAt: Date.now() };
    const bytes = new TextEncoder().encode(JSON.stringify(plaintext));
    const [genuineEnvelopeFromMallory] = await mallory.fanout.encryptForMembers(bytes, [{ userId: bob.userId, deviceId: bob.deviceId }], {
      conversationId: malloryPlainConvId,
      senderUserId: mallory.userId,
      senderDeviceId: mallory.deviceId,
    });

    // Forge the sender field to Alice's userId. The ciphertext itself is
    // still Mallory's real ratchet output — bob.decryptEnvelope will pick
    // Bob's ALREADY-ESTABLISHED session with "Alice" (per the forged field,
    // now on its second message, not a fresh PreKey handshake) to decrypt
    // Mallory's bytes, which fails: sender identity is bound to the session
    // state, not this relay-carried field.
    const forged = { ...genuineEnvelopeFromMallory!, senderUserId: alice.userId };

    await bob.handleIncomingEnvelope(forged);
    expect(bobMsgs).toHaveLength(0); // never surfaced — dropped silently, exactly like any other undecryptable envelope

    alice.disconnect();
    bob.disconnect();
    mallory.disconnect();
  }, 20_000);
});

describe("prekey replenishment", () => {
  it("detects an exhausted one-time-prekey pool and republishes a fresh batch", async () => {
    const dave = await signupClient(relayUrl(), uniqueUsername("dave"), { initialOneTimePreKeyCount: 2 });
    const erin = await signupClient(relayUrl(), uniqueUsername("erin"));
    const frank = await signupClient(relayUrl(), uniqueUsername("frank"));

    // Each resolveUser() call consumes exactly one of dave's one-time prekeys — two callers exhaust his pool of 2.
    await erin.resolveUser(dave.username);
    await frank.resolveUser(dave.username);

    const devicesRow = await harness.prisma.device.findFirst({ where: { userId: dave.userId, replacedAt: null } });
    expect(devicesRow).not.toBeNull();
    const remainingBeforeReplenish = await harness.prisma.oneTimePreKey.count({ where: { deviceId: devicesRow!.id } });
    expect(remainingBeforeReplenish).toBe(0);

    const replenished = await dave.checkAndReplenishPrekeys(5);
    expect(replenished).toBe(true);

    const remainingAfterReplenish = await harness.prisma.oneTimePreKey.count({ where: { deviceId: devicesRow!.id } });
    expect(remainingAfterReplenish).toBe(5);

    // A fresh fetch now gets a one-time prekey again (proves the relay hands out the new ones, not just that rows exist).
    const transport = createHttpWsTransport(relayUrl());
    const freshBundles = await transport.fetchBundles(erin.token, dave.username);
    expect(freshBundles[0]!.preKeyId).toBeDefined();

    dave.disconnect();
    erin.disconnect();
    frank.disconnect();
  }, 20_000);
});

describe("identity key change", () => {
  it("fires identityKeyChanged when a peer re-registers a device under a new identity key", async () => {
    const alice = await signupClient(relayUrl(), uniqueUsername("alice"));
    const bob = await signupClient(relayUrl(), uniqueUsername("bob"));

    const aliceEvents = collectEvents(alice);
    const bobMsgsOriginal = collectMessages(bob);

    await alice.resolveUser(bob.username);
    const convId = await alice.createConversation([bob.userId]);
    await bob.listMembers(convId);

    await alice.send(convId, "hi bob (original device)");
    await waitUntil(() => bobMsgsOriginal.length === 1);

    const bobToken = bob.token;
    const bobUserId = bob.userId;
    bob.disconnect();

    // Simulate bob reinstalling: same relay account, brand-new identity + prekeys.
    const bob2 = await SignalAiClient.reregisterDevice({
      relayUrl: relayUrl(),
      userId: bobUserId,
      token: bobToken,
      username: bob.username,
      initialOneTimePreKeyCount: 3,
    });
    const bob2Msgs = collectMessages(bob2);
    // A reinstalled device has no local memory of prior conversations (the relay has no
    // multi-device sync/"list my conversations" endpoint) — it must be told convId out-of-band,
    // same as any other newly-relevant participant (see bob's listMembers call above).
    await bob2.listMembers(convId);

    // Alice re-resolves bob: fetches his now-current (new) bundle, detects the identity key changed, and re-keys.
    await alice.resolveUser(bob.username);
    expect(aliceEvents.some((e) => e.type === "identityKeyChanged" && e.userId === bobUserId && e.deviceId === 1)).toBe(true);

    const msgId = await alice.send(convId, "hi bob (new device)");
    await waitUntil(() => bob2Msgs.length === 1);
    expect(bob2Msgs[0]!.msgId).toBe(msgId);

    alice.disconnect();
    bob2.disconnect();
  }, 20_000);
});
