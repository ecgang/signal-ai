import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { PreKeyBundlePublic } from "@signalai/proto";
import { buildApp } from "../src/index.js";
import { createPrismaClient, enqueueEnvelope, ackEnvelopes, drainPendingEnvelopes } from "../src/db.js";

/**
 * Relay integration tests. These run against the real Postgres from the
 * repo-root docker-compose (`docker compose up -d db`), because the relay's
 * whole job — atomic prekey consumption, mailbox drain/ack, membership
 * enforcement — lives in queries a mock can't exercise honestly.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/signalai";
const INVITE = "LETMEIN";

let prisma: PrismaClient;
let app: FastifyInstance;

const b64 = (n = 32): string => randomBytes(n).toString("base64");

/**
 * A wire-shaped prekey bundle with random (opaque) key bytes — the relay never
 * cryptographically validates key material, so this exercises every relay path
 * without the cost of real libsignal keygen.
 */
function makeBundle(
  userId: string,
  deviceId = 1,
  opts: { identityKey?: string; oneTime?: boolean; preKeyId?: number } = {},
): PreKeyBundlePublic {
  return {
    userId,
    deviceId,
    registrationId: 1234,
    identityKey: opts.identityKey ?? b64(33),
    signedPreKeyId: 1,
    signedPreKeyPublic: b64(33),
    signedPreKeySignature: b64(64),
    ...(opts.oneTime === false ? {} : { preKeyId: opts.preKeyId ?? 1, preKeyPublic: b64(33) }),
    kyberPreKeyId: 1,
    kyberPreKeyPublic: b64(1568),
    kyberPreKeySignature: b64(64),
  };
}

async function resetDb(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE users, devices, signed_prekeys, kyber_prekeys, one_time_prekeys, conversations, memberships, envelopes RESTART IDENTITY CASCADE`,
  );
}

beforeAll(async () => {
  prisma = createPrismaClient(DATABASE_URL);
  app = buildApp({ port: 0, databaseUrl: DATABASE_URL, inviteCodes: [INVITE], nodeEnv: "test" }, prisma);
  await app.listen({ port: 0, host: "127.0.0.1" });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

beforeEach(resetDb);

function wsPort(): number {
  return (app.server.address() as AddressInfo).port;
}
const auth = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

interface Account {
  userId: string;
  token: string;
  username: string;
}

// The per-IP signup rate limiter and the invite-code lockout both key on the
// source address and persist for the app's lifetime, so tests must not share
// an IP or one test's failures poison another's signups. Each signup gets a
// fresh source IP unless a test deliberately pins one (e.g. the lockout test).
let ipSeq = 0;
function freshIp(): string {
  ipSeq += 1;
  return `10.${(ipSeq >> 8) & 255}.${ipSeq & 255}.1`;
}

async function signupRaw(username: string, inviteCode = INVITE, ip = freshIp()) {
  return app.inject({
    method: "POST",
    url: "/signup",
    payload: { username, inviteCode },
    remoteAddress: ip,
  });
}

async function signup(username: string, deviceId = 1): Promise<Account> {
  const res = await signupRaw(username);
  expect(res.statusCode).toBe(201);
  const { userId, token } = res.json() as { userId: string; token: string };
  const dev = await app.inject({
    method: "POST",
    url: "/devices",
    headers: auth(token),
    payload: { userId, bundle: makeBundle(userId, deviceId) },
  });
  expect(dev.statusCode).toBe(201);
  return { userId, token, username };
}

/** Minimal promise-based WS client with a deterministic `ready` barrier. */
class TestSocket {
  private ws: WebSocket;
  readonly messages: Array<Record<string, unknown>> = [];
  private waiters: Array<{
    pred: (m: Record<string, unknown>) => boolean;
    resolve: (m: Record<string, unknown>) => void;
  }> = [];
  private closeCode: number | undefined;

  constructor(path = "/ws", protocols?: string[]) {
    this.ws = new WebSocket(`ws://127.0.0.1:${wsPort()}${path}`, protocols);
    this.ws.on("message", (data: Buffer) => {
      const m = JSON.parse(data.toString()) as Record<string, unknown>;
      this.messages.push(m);
      this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.resolve(m), false) : true));
    });
    this.ws.on("close", (code: number) => {
      this.closeCode = code;
    });
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
  }

  waitFor(pred: (m: Record<string, unknown>) => boolean, timeoutMs = 3000): Promise<Record<string, unknown>> {
    const existing = this.messages.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("waitFor timed out")), timeoutMs);
      this.waiters.push({ pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
    });
  }

  waitClose(timeoutMs = 3000): Promise<number> {
    if (this.closeCode !== undefined) return Promise.resolve(this.closeCode);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("close timed out")), timeoutMs);
      this.ws.once("close", (code: number) => (clearTimeout(t), resolve(code)));
    });
  }

  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  /** Auth via a first `auth` frame, resolving once the server's `ready` frame arrives. */
  async authWithFrame(token: string, deviceId: number): Promise<void> {
    await this.open();
    this.send({ type: "auth", token, deviceId });
    await this.waitFor((m) => m.type === "ready");
  }

  close(): void {
    this.ws.close();
  }

  /** Settle so "nothing was delivered" assertions aren't racing an in-flight frame. */
  static settle(ms = 250): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

function sendFrame(from: Account, toUserId: string, conversationId: string, text: string, deviceId = 1) {
  return {
    type: "send",
    recipientUserId: toUserId,
    envelope: {
      conversationId,
      senderUserId: from.userId,
      senderDeviceId: deviceId,
      recipientDeviceId: 1,
      seq: 1,
      ciphertext: Buffer.from(text).toString("base64"),
      type: 2,
    },
  };
}

async function createConversation(creator: Account, memberUserIds: string[]): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/conversations",
    headers: auth(creator.token),
    payload: { creatorUserId: creator.userId, memberUserIds, aiMode: false },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { conversationId: string }).conversationId;
}

describe("signup + invite gating", () => {
  it("issues a token for a valid invite code and rejects an invalid one", async () => {
    const ok = await signupRaw("alice");
    expect(ok.statusCode).toBe(201);
    expect((ok.json() as { token: string }).token).toBeTruthy();

    const bad = await signupRaw("mallory", "WRONG");
    expect(bad.statusCode).toBe(403);
  });

  it("locks out an IP after repeated invalid invite codes (signup brute-force guard)", async () => {
    // maxFailures = 5 wrong codes → subsequent attempts are 429 locked_out,
    // even a correct code — distinct from the per-IP request rate limiter.
    // Pin one IP for the whole sequence; isolated from every other test's IP.
    const ip = "10.255.255.1";
    for (let i = 0; i < 5; i++) {
      const r = await signupRaw(`x${i}`, "WRONG", ip);
      expect(r.statusCode).toBe(403);
    }
    const locked = await signupRaw("late", INVITE, ip);
    expect(locked.statusCode).toBe(429);
  });
});

describe("prekey bundle consumption", () => {
  it("consumes a one-time prekey exactly once", async () => {
    const alice = await signup("alice");

    const first = await app.inject({ method: "GET", url: `/users/alice/bundle`, headers: auth(alice.token) });
    expect(first.statusCode).toBe(200);
    const firstBundle = (first.json() as { bundles: PreKeyBundlePublic[] }).bundles[0]!;
    expect(firstBundle.preKeyId).toBeDefined(); // got the one-time prekey

    const second = await app.inject({ method: "GET", url: `/users/alice/bundle`, headers: auth(alice.token) });
    const secondBundle = (second.json() as { bundles: PreKeyBundlePublic[] }).bundles[0]!;
    expect(secondBundle.preKeyId).toBeUndefined(); // it was consumed; never handed out twice
  });
});

describe("prekey bundle fetch by userId", () => {
  it("returns a bundle for a known userId (enables session with a member known only by userId)", async () => {
    const alice = await signup("alice");
    const bob = await signup("bob");

    const res = await app.inject({
      method: "GET",
      url: `/users/by-id/${alice.userId}/bundle`,
      headers: auth(bob.token),
    });
    expect(res.statusCode).toBe(200);
    const bundle = (res.json() as { bundles: PreKeyBundlePublic[] }).bundles[0]!;
    expect(bundle).toBeDefined();
    expect(bundle.userId).toBe(alice.userId);
  });

  it("returns an empty bundle list (not 404) for an unknown userId", async () => {
    const bob = await signup("bob");

    const res = await app.inject({
      method: "GET",
      url: `/users/by-id/does-not-exist/bundle`,
      headers: auth(bob.token),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { bundles: PreKeyBundlePublic[] }).bundles).toEqual([]);
  });

  it("requires authentication", async () => {
    const alice = await signup("alice");
    const res = await app.inject({ method: "GET", url: `/users/by-id/${alice.userId}/bundle` });
    expect(res.statusCode).toBe(401);
  });
});

describe("conversation + membership authorization", () => {
  it("creates a conversation, lists members, and patches ai-mode", async () => {
    const alice = await signup("alice");
    const bob = await signup("bob");
    const conversationId = await createConversation(alice, [alice.userId, bob.userId]);

    const members = await app.inject({
      method: "GET",
      url: `/conversations/${conversationId}/members`,
      headers: auth(alice.token),
    });
    expect(members.statusCode).toBe(200);
    expect((members.json() as { members: unknown[] }).members).toHaveLength(2);

    const patch = await app.inject({
      method: "PATCH",
      url: `/conversations/${conversationId}/ai-mode`,
      headers: auth(alice.token),
      payload: { enabled: true },
    });
    expect(patch.statusCode).toBe(200);
  });

  it("rejects a membership change by a non-admin member with 403", async () => {
    const alice = await signup("alice");
    const bob = await signup("bob");
    const carol = await signup("carol");
    const conversationId = await createConversation(alice, [alice.userId, bob.userId]);

    // Bob is a plain member, not the creator/admin — he cannot invite Carol.
    const res = await app.inject({
      method: "POST",
      url: `/conversations/${conversationId}/invite`,
      headers: auth(bob.token),
      payload: { userId: carol.userId },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("WebSocket auth transport", () => {
  it("refuses a token supplied as a query-string parameter", async () => {
    const alice = await signup("alice");
    const sock = new TestSocket(`/ws?token=${alice.token}`);
    const code = await sock.waitClose();
    expect(code).toBe(4001);
  });

  it("authenticates via the Sec-WebSocket-Protocol header plus a hello frame", async () => {
    const alice = await signup("alice");
    // Header-auth: offer the sentinel subprotocol + the token; the server
    // echoes only the sentinel, so the ws handshake completes cleanly.
    const sock = new TestSocket("/ws", ["signalai-bearer", alice.token]);
    await sock.open();
    sock.send({ type: "hello", deviceId: 1 });
    const ready = await sock.waitFor((m) => m.type === "ready");
    expect(ready.type).toBe("ready");
    sock.close();
  });
});

describe("mailbox ack is per-seq exact (group anti-orphaning)", () => {
  it("acking a later seq leaves an earlier un-acked seq from another sender intact", async () => {
    const alice = await signup("alice");
    const bob = await signup("bob");
    const carol = await signup("carol");
    const conversationId = await createConversation(alice, [alice.userId, bob.userId, carol.userId]);

    // Carol's group mailbox interleaves two senders: Alice's envelope is
    // enqueued first (lower global seq), Bob's second (higher seq).
    const fromAlice = await enqueueEnvelope(prisma, {
      conversationId,
      recipientUserId: carol.userId,
      recipientDeviceId: 1,
      senderUserId: alice.userId,
      senderDeviceId: 1,
      type: 2,
      ciphertext: Buffer.from("from-alice").toString("base64"),
    });
    const fromBob = await enqueueEnvelope(prisma, {
      conversationId,
      recipientUserId: carol.userId,
      recipientDeviceId: 1,
      senderUserId: bob.userId,
      senderDeviceId: 1,
      type: 2,
      ciphertext: Buffer.from("from-bob").toString("base64"),
    });
    expect(fromBob.seq > fromAlice.seq).toBe(true);

    // Carol finishes Bob's (higher-seq) message first and acks it before she
    // has processed Alice's. Cumulative `seq <= ack` delete would drop Alice's
    // still-pending envelope; exact per-seq delete must leave it queued.
    await ackEnvelopes(prisma, {
      recipientUserId: carol.userId,
      recipientDeviceId: 1,
      conversationId,
      seq: fromBob.seq,
    });

    const pending = await drainPendingEnvelopes(prisma, {
      recipientUserId: carol.userId,
      recipientDeviceId: 1,
      conversationIds: [conversationId],
    });
    expect(pending.map((e) => e.seq)).toEqual([fromAlice.seq]);
    expect(Buffer.from(pending[0]!.ciphertext).toString()).toBe("from-alice");
  });
});

describe("mailbox store-and-forward", () => {
  it("holds envelopes for an offline recipient and drains them in order on reconnect, deleting on ack", async () => {
    const alice = await signup("alice");
    const bob = await signup("bob");
    const conversationId = await createConversation(alice, [alice.userId, bob.userId]);

    // Bob is offline. Alice connects and sends three messages.
    const aliceSock = new TestSocket();
    await aliceSock.authWithFrame(alice.token, 1);
    for (const text of ["one", "two", "three"]) {
      aliceSock.send(sendFrame(alice, bob.userId, conversationId, text));
    }

    // Wait until all three are persisted (deterministic barrier, no sleeps).
    await expect
      .poll(async () => prisma.envelope.count({ where: { recipientUserId: bob.userId } }), { timeout: 3000 })
      .toBe(3);

    // Bob connects: the server drains his mailbox in seq order on `ready`.
    const bobSock = new TestSocket();
    await bobSock.authWithFrame(bob.token, 1);
    await expect.poll(() => bobSock.messages.filter((m) => m.type === "deliver").length, { timeout: 3000 }).toBe(3);

    const delivered = bobSock.messages
      .filter((m) => m.type === "deliver")
      .map((m) => {
        const env = (m as { envelope: { seq: number; ciphertext: string } }).envelope;
        return { seq: env.seq, text: Buffer.from(env.ciphertext, "base64").toString() };
      });
    expect(delivered.map((d) => d.text)).toEqual(["one", "two", "three"]);
    expect(delivered.map((d) => d.seq)).toEqual([...delivered.map((d) => d.seq)].sort((a, b) => a - b));

    // Bob acks each delivered envelope by its own seq — exactly as the real
    // client's per-envelope `safeAck` does. Acking is per-seq exact, not
    // cumulative: a single ack of the last seq deletes only that one row (a
    // cumulative `seq <= ack` delete would orphan an interleaved earlier seq
    // from another sender in a group mailbox — see ackEnvelopes + the orphaning
    // test below).
    for (const seq of delivered.map((d) => d.seq)) {
      bobSock.send({ type: "ack", conversationId, seq });
    }
    await expect
      .poll(async () => prisma.envelope.count({ where: { recipientUserId: bob.userId } }), { timeout: 3000 })
      .toBe(0);

    aliceSock.close();
    bobSock.close();
  });

  it("closes the socket when a non-member tries to enqueue into a conversation", async () => {
    const alice = await signup("alice");
    const mallory = await signup("mallory");
    const bob = await signup("bob");
    const conversationId = await createConversation(alice, [alice.userId, bob.userId]);

    const sock = new TestSocket();
    await sock.authWithFrame(mallory.token, 1);
    sock.send(sendFrame(mallory, bob.userId, conversationId, "intrusion"));
    const code = await sock.waitClose();
    expect(code).toBe(4003);
    expect(await prisma.envelope.count()).toBe(0);
  });

  it("does not deliver a removed member the conversation's later traffic", async () => {
    const alice = await signup("alice");
    const carol = await signup("carol");
    const conversationId = await createConversation(alice, [alice.userId, carol.userId]);

    // Remove Carol, then Alice sends into the (now Carol-less) conversation.
    const removed = await app.inject({
      method: "POST",
      url: `/conversations/${conversationId}/remove`,
      headers: auth(alice.token),
      payload: { userId: carol.userId },
    });
    expect(removed.statusCode).toBe(200);

    const aliceSock = new TestSocket();
    await aliceSock.authWithFrame(alice.token, 1);
    // Carol is gone, so she is no longer a recipient; anything Alice sends must
    // not land in Carol's mailbox. Alice attempts anyway.
    aliceSock.send(sendFrame(alice, carol.userId, conversationId, "after removal"));
    await TestSocket.settle();

    const carolSock = new TestSocket();
    await carolSock.authWithFrame(carol.token, 1);
    await TestSocket.settle();
    expect(carolSock.messages.filter((m) => m.type === "deliver")).toHaveLength(0);

    aliceSock.close();
    carolSock.close();
  });
});

describe("connection limits", () => {
  it("closes the socket when an oversized envelope is sent (size cap)", async () => {
    const alice = await signup("alice");
    const sock = new TestSocket();
    await sock.authWithFrame(alice.token, 1);
    // A frame larger than the 64 KB cap must be rejected with close code 1009.
    sock.send({ big: "x".repeat(70 * 1024) });
    const code = await sock.waitClose();
    expect(code).toBe(1009);
  });

  it("closes the socket when a client floods it past the per-connection frame rate", async () => {
    const alice = await signup("alice");
    const sock = new TestSocket();
    await sock.authWithFrame(alice.token, 1);
    // Blow past MAX_FRAMES_PER_WINDOW (200) with valid, side-effect-free frames
    // (an `ack` for a conversation with nothing to ack is a harmless no-op), so
    // the socket closes on the rate limit rather than on frame validation.
    for (let i = 0; i < 205; i++) sock.send({ type: "ack", conversationId: "none", seq: 0 });
    const code = await sock.waitClose();
    expect(code).toBe(1008);
  });
});

describe("device re-registration", () => {
  it("preserves the prior identity key (marks it replaced) so a key change is detectable", async () => {
    const alice = await signup("alice"); // registers device 1 with identity key #1

    // Re-register device 1 with a DIFFERENT identity key.
    const newIdentity = b64(33);
    const res = await app.inject({
      method: "POST",
      url: "/devices",
      headers: auth(alice.token),
      payload: { userId: alice.userId, bundle: makeBundle(alice.userId, 1, { identityKey: newIdentity }) },
    });
    expect(res.statusCode).toBe(201);

    const devices = await prisma.device.findMany({ where: { userId: alice.userId, deviceId: 1 } });
    // Two rows: the old one marked replaced, the new one active — the old key
    // is not silently overwritten, which is what makes the change detectable.
    expect(devices).toHaveLength(2);
    expect(devices.filter((d) => d.replacedAt !== null)).toHaveLength(1);
    expect(devices.filter((d) => d.replacedAt === null)).toHaveLength(1);
  });
});

describe("health", () => {
  it("reports db ok", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { db: string }).db).toBe("ok");
  });
});
