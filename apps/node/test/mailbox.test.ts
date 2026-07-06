import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createPrismaClient } from "../src/db.js";
import { MailboxService } from "../src/mailbox.js";

/**
 * Plan 003 (P1 node demotion) — direct tests of `MailboxService` itself
 * (apps/node/src/mailbox.ts), separate from the WS-transport-level mailbox
 * tests in index.test.ts. These exercise `store`/`drain`/`ack` directly
 * against the real Postgres from the repo-root docker-compose, because the
 * two properties under test — exact-once forwarding and ciphertext opacity —
 * are properties of the class's own queries, not of the WS framing around
 * them.
 *
 * No mocks: MailboxService wraps real `enqueueEnvelope`/`drainPendingEnvelopes`/
 * `ackEnvelopes` Postgres queries (db.ts), so a fake store would prove nothing
 * about the actual per-seq exact-ack invariant this class must preserve.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/signalai";

let prisma: PrismaClient;
let mailbox: MailboxService;

async function resetDb(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE users, devices, signed_prekeys, kyber_prekeys, one_time_prekeys, conversations, memberships, envelopes RESTART IDENTITY CASCADE`,
  );
}

beforeAll(async () => {
  prisma = createPrismaClient(DATABASE_URL);
  mailbox = new MailboxService(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(resetDb);

/**
 * Bare minimum rows to satisfy the Envelope->Conversation->User FK chain
 * (schema.prisma: Envelope.conversationId -> Conversation, Conversation.createdBy
 * -> User) without pulling in the whole HTTP/signup layer — this suite tests
 * MailboxService in isolation, not the route handlers around it.
 */
async function makeConversation(): Promise<{ conversationId: string; creatorId: string }> {
  const creator = await prisma.user.create({ data: { username: `u-${randomBytes(4).toString("hex")}`, tokenHash: "x" } });
  const conversation = await prisma.conversation.create({ data: { createdBy: creator.id } });
  return { conversationId: conversation.id, creatorId: creator.id };
}

describe("MailboxService — exact-once store-and-forward for an offline recipient", () => {
  it("stores an envelope for offline recipient R, then drains it exactly once on reconnect and it is gone after ack", async () => {
    const { conversationId, creatorId: senderUserId } = await makeConversation();
    const recipientUserId = `r-${randomBytes(4).toString("hex")}`;
    const recipientDeviceId = 1;

    // R is offline: no drain has happened yet. Store one opaque envelope for R.
    const stored = await mailbox.store({
      conversationId,
      recipientUserId,
      recipientDeviceId,
      senderUserId,
      senderDeviceId: 1,
      type: 2,
      ciphertext: Buffer.from("hello-r").toString("base64"),
    });
    expect(stored.seq).toBeDefined();

    // R "reconnects": drains its mailbox. Must forward exactly the one stored
    // envelope — not zero, not duplicated.
    const firstDrain = await mailbox.drain({
      recipientUserId,
      recipientDeviceId,
      conversationIds: [conversationId],
    });
    expect(firstDrain).toHaveLength(1);
    expect(firstDrain[0]!.seq).toBe(stored.seq);
    expect(Buffer.from(firstDrain[0]!.ciphertext).toString()).toBe("hello-r");

    // A second drain BEFORE ack still returns it (drain is not itself
    // destructive — only ack retires an envelope). This is what distinguishes
    // "exact-once forward" (guaranteed at least once until acked, exactly the
    // envelope stored, no drift) from "exactly-once delivery" in the stronger,
    // at-most-once sense the ack step below provides.
    const secondDrainBeforeAck = await mailbox.drain({
      recipientUserId,
      recipientDeviceId,
      conversationIds: [conversationId],
    });
    expect(secondDrainBeforeAck).toHaveLength(1);
    expect(secondDrainBeforeAck[0]!.seq).toBe(stored.seq);

    // R acks by the envelope's own seq (the real client's per-envelope
    // safeAck). Exactly one row is retired.
    const ackedCount = await mailbox.ack({
      recipientUserId,
      recipientDeviceId,
      conversationId,
      seq: stored.seq,
    });
    expect(ackedCount).toBe(1);

    // Now the mailbox is empty for R: the forward truly happened exactly
    // once end-to-end (stored once, delivered, acked, never redelivered).
    const drainAfterAck = await mailbox.drain({
      recipientUserId,
      recipientDeviceId,
      conversationIds: [conversationId],
    });
    expect(drainAfterAck).toHaveLength(0);
  });
});

describe("MailboxService — ciphertext opacity", () => {
  it("forwards an opaque byte blob that is NOT a valid EnvelopeSchema/PlaintextMessage body completely unchanged", async () => {
    const { conversationId, creatorId: senderUserId } = await makeConversation();
    const recipientUserId = `r-${randomBytes(4).toString("hex")}`;

    // Deliberately NOT valid JSON, NOT a valid EnvelopeSchema/PlaintextMessage
    // body — pure random bytes. If MailboxService ever parsed, decoded, or
    // mutated `ciphertext`, this would either throw or come back different.
    const opaqueBlob = randomBytes(256);
    expect(() => JSON.parse(opaqueBlob.toString("utf8"))).toThrow();

    const stored = await mailbox.store({
      conversationId,
      recipientUserId,
      recipientDeviceId: 1,
      senderUserId,
      senderDeviceId: 1,
      type: 2,
      ciphertext: opaqueBlob.toString("base64"),
    });
    // The store call itself must not have thrown or altered the bytes.
    expect(Buffer.from(stored.ciphertext).equals(opaqueBlob)).toBe(true);

    const [forwarded] = await mailbox.drain({
      recipientUserId,
      recipientDeviceId: 1,
      conversationIds: [conversationId],
    });
    expect(forwarded).toBeDefined();
    // Byte-for-byte identical round-trip through store -> drain: proof
    // MailboxService never parses, decodes, or inspects `ciphertext` as a
    // structured body — an opaque blob that isn't even valid JSON survives
    // unchanged because the mailbox never looks inside it.
    expect(Buffer.from(forwarded!.ciphertext).equals(opaqueBlob)).toBe(true);
  });
});
