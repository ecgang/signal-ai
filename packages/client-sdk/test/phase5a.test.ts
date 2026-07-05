import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SignalAiClient, createHttpWsTransport, InMemoryClientStores, type Transport } from "../src/index.js";
import {
  type RelayHarness,
  INVITE_CODE,
  startRelay,
  stopRelay,
  resetDb,
  uniqueUsername,
  signupClient,
  collectMessages,
  waitUntil,
} from "./helpers.js";

/**
 * Phase 5A enablers, proven against the real relay + Postgres + core crypto
 * (same harness as e2e.test.ts): (1) InMemoryClientStores serialize/rehydrate,
 * (2) SignalAiClient.resume() — reconnect the SAME identity with NO re-publish,
 * ratchet state intact, (3) the opt-in `autoResolveMembersById` path that lets
 * a member establish a session with a co-member it knows only by userId.
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

/** A transport that counts the calls which would ROTATE/PUBLISH keys, so a test can assert resume() publishes nothing. */
function countingTransport(url: string): { transport: Transport; calls: { signup: number; publishDevice: number } } {
  const base = createHttpWsTransport(url);
  const calls = { signup: 0, publishDevice: 0 };
  const transport: Transport = {
    ...base,
    async signup(req) {
      calls.signup += 1;
      return base.signup(req);
    },
    async publishDevice(token, userId, bundle) {
      calls.publishDevice += 1;
      return base.publishDevice(token, userId, bundle);
    },
  };
  return { transport, calls };
}

describe("client store serialization", () => {
  it("round-trips directory, conversations, seenMsgIds, and session records", async () => {
    const alice = await signupClient(relayUrl(), uniqueUsername("alice"));
    const bob = await signupClient(relayUrl(), uniqueUsername("bob"));

    // resolveUser populates `directory` AND establishes a session (records land in the session store).
    await alice.resolveUser(bob.username);
    // createConversation populates `conversations`.
    const convId = await alice.createConversation([bob.userId]);
    // Simulate a delivered message so `seenMsgIds` is non-empty.
    alice.stores.seenMsgIds.add("msg-abc");

    const snapshot = alice.stores.toJSON();
    const rehydrated = InMemoryClientStores.fromJSON(snapshot);

    expect(rehydrated.directory.get(bob.userId)?.username).toBe(bob.username);
    expect(rehydrated.conversations.has(convId)).toBe(true);
    expect(rehydrated.seenMsgIds.has("msg-abc")).toBe(true);
    // Idempotent re-serialization proves the session records (and every other store) survived byte-for-byte.
    expect(rehydrated.session.toJSON().length).toBeGreaterThan(0);
    expect(JSON.stringify(rehydrated.toJSON())).toBe(JSON.stringify(snapshot));

    alice.disconnect();
    bob.disconnect();
  }, 20_000);
});

describe("resume (reconnect same identity, no key rotation)", () => {
  it("reconnects from persisted state, publishes nothing, and the ratchet survives a restart", async () => {
    const alice = await signupClient(relayUrl(), uniqueUsername("alice"));
    const bob = await signupClient(relayUrl(), uniqueUsername("bob"));
    const bobMsgs = collectMessages(bob);

    await alice.resolveUser(bob.username);
    await bob.resolveUser(alice.username);
    const convId = await alice.createConversation([bob.userId]);
    await bob.listMembers(convId);

    // Advance the ratchet BOTH ways before snapshotting.
    const aliceMsgs1 = collectMessages(alice);
    const m1 = await alice.send(convId, "pre-restart from alice");
    await waitUntil(() => bobMsgs.some((m) => m.msgId === m1));
    const m2 = await bob.send(convId, "pre-restart from bob");
    await waitUntil(() => aliceMsgs1.some((m) => m.msgId === m2));

    // Persist exactly what a durable store would.
    const persisted = {
      relayUrl: relayUrl(),
      token: alice.token,
      userId: alice.userId,
      username: alice.username,
      deviceId: alice.deviceId,
      serializedIdentity: alice.serializedIdentity,
      serializedStores: alice.stores.toJSON(),
      nextOneTimePreKeyId: alice.nextPreKeyId,
    };

    alice.disconnect();

    // Ground-truth counts BEFORE resume: a republish would add a signed-prekey
    // row; a re-register would add a device row. Counts are the robust check
    // (comparing a Bytes column via toBe() compares Buffer identity, not bytes).
    const devicesBefore = await harness.prisma.device.count({ where: { userId: alice.userId } });
    const signedBefore = await harness.prisma.signedPreKey.count({ where: { device: { userId: alice.userId } } });

    const { transport, calls } = countingTransport(relayUrl());
    const resumed = await SignalAiClient.resume({ ...persisted, transport });
    const resumedMsgs = collectMessages(resumed);

    // No re-signup, no bundle republish — resume() must never rotate keys.
    expect(calls.signup).toBe(0);
    expect(calls.publishDevice).toBe(0);
    expect(await harness.prisma.device.count({ where: { userId: alice.userId } })).toBe(devicesBefore);
    expect(await harness.prisma.signedPreKey.count({ where: { device: { userId: alice.userId } } })).toBe(
      signedBefore,
    );

    // Ratchet survived: post-restart traffic decrypts both directions, and bob
    // never sees an identityKeyChanged (alice's identity is byte-for-byte the same).
    const m3 = await resumed.send(convId, "post-restart from alice");
    await waitUntil(() => bobMsgs.some((m) => m.msgId === m3 && m.text === "post-restart from alice"));
    const m4 = await bob.send(convId, "post-restart from bob");
    await waitUntil(() => resumedMsgs.some((m) => m.msgId === m4 && m.text === "post-restart from bob"));

    resumed.disconnect();
    bob.disconnect();
  }, 30_000);
});

describe("autoResolveMembersById (opt-in userId session path)", () => {
  it("lets an opted-in member message a co-member it knows only by userId", async () => {
    // The agent-like member opts in; a human creates the conversation and invites it.
    const agentLike = await SignalAiClient.signup({
      relayUrl: relayUrl(),
      inviteCode: INVITE_CODE,
      username: uniqueUsername("agent"),
      autoResolveMembersById: true,
    });
    const human = await signupClient(relayUrl(), uniqueUsername("human"));
    const humanMsgs = collectMessages(human);

    await human.resolveUser(agentLike.username);
    const convId = await human.createConversation([agentLike.userId]);

    // The agent learns members ONLY by userId (no resolveUser by username), exactly as it would from an invite.
    const members = await agentLike.listMembers(convId);
    expect(members.some((m) => m.userId === human.userId)).toBe(true);
    expect(agentLike.stores.directory.has(human.userId)).toBe(false);

    // Sending still works: ensureSession falls back to fetch-by-userId.
    const intro = await agentLike.send(convId, "I'm the AI member of this chat.");
    await waitUntil(() => humanMsgs.some((m) => m.msgId === intro && m.text === "I'm the AI member of this chat."));

    agentLike.disconnect();
    human.disconnect();
  }, 20_000);

  it("still refuses (default off) to message an unresolved userId — the human-CLI trust surface is unchanged", async () => {
    const erin = await signupClient(relayUrl(), uniqueUsername("erin")); // default: autoResolveMembersById OFF
    const frank = await signupClient(relayUrl(), uniqueUsername("frank"));

    await frank.resolveUser(erin.username);
    const convId = await frank.createConversation([erin.userId]);

    await erin.listMembers(convId); // erin learns frank's userId but never resolved him by username
    expect(erin.stores.directory.has(frank.userId)).toBe(false);

    await expect(erin.send(convId, "hi frank")).rejects.toThrow(/call resolveUser/);

    erin.disconnect();
    frank.disconnect();
  }, 20_000);
});
