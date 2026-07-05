import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma, type Device } from "@prisma/client";
import type { PreKeyBundlePublic } from "@signalai/proto";

export function createPrismaClient(databaseUrl: string): PrismaClient {
  const adapter = new PrismaPg(databaseUrl);
  return new PrismaClient({ adapter });
}

export async function pingDb(prisma: PrismaClient): Promise<boolean> {
  await prisma.$queryRaw`SELECT 1`;
  return true;
}

function toBytes(base64: string): Buffer {
  return Buffer.from(base64, "base64");
}
function toBase64(bytes: Uint8Array | Buffer): string {
  return Buffer.from(bytes).toString("base64");
}

// ---------------------------------------------------------------------------
// Devices + prekeys
// ---------------------------------------------------------------------------

/**
 * Registers (or re-registers) a device's identity + prekey material.
 *
 * If a device already exists for (userId, deviceId) with a DIFFERENT
 * identityKey, the old row is closed out via `replacedAt` and a brand new
 * Device row is created — the old identity key is never silently
 * overwritten, so identity-key rotation is always visible in history.
 * Same identity key => in-place refresh (rotationId bump only).
 *
 * The signed + Kyber prekeys are always (re)published as new rows (latest
 * wins by createdAt); an optional one-time prekey, if present, is appended
 * to that device's pool rather than replacing anything in it.
 */
export async function registerDevice(
  prisma: PrismaClient,
  params: { userId: string; bundle: PreKeyBundlePublic },
): Promise<void> {
  const { userId, bundle } = params;
  const identityKeyBytes = toBytes(bundle.identityKey);

  await prisma.$transaction(async (tx) => {
    const current = await tx.device.findFirst({
      where: { userId, deviceId: bundle.deviceId, replacedAt: null },
    });

    let device: Device;
    if (!current) {
      device = await tx.device.create({
        data: {
          userId,
          deviceId: bundle.deviceId,
          identityKey: identityKeyBytes,
          registrationId: bundle.registrationId,
        },
      });
    } else if (!Buffer.from(current.identityKey).equals(identityKeyBytes)) {
      await tx.device.update({ where: { id: current.id }, data: { replacedAt: new Date() } });
      device = await tx.device.create({
        data: {
          userId,
          deviceId: bundle.deviceId,
          identityKey: identityKeyBytes,
          registrationId: bundle.registrationId,
        },
      });
    } else {
      device = await tx.device.update({
        where: { id: current.id },
        data: { registrationId: bundle.registrationId },
      });
    }

    await tx.signedPreKey.create({
      data: {
        deviceId: device.id,
        keyId: bundle.signedPreKeyId,
        publicKey: toBytes(bundle.signedPreKeyPublic),
        signature: toBytes(bundle.signedPreKeySignature),
      },
    });
    await tx.kyberPreKey.create({
      data: {
        deviceId: device.id,
        keyId: bundle.kyberPreKeyId,
        publicKey: toBytes(bundle.kyberPreKeyPublic),
        signature: toBytes(bundle.kyberPreKeySignature),
      },
    });
    if (bundle.preKeyId !== undefined && bundle.preKeyPublic !== undefined) {
      await tx.oneTimePreKey.create({
        data: {
          deviceId: device.id,
          keyId: bundle.preKeyId,
          publicKey: toBytes(bundle.preKeyPublic),
        },
      });
    }
  });
}

interface OneTimePreKeyRow {
  keyId: number;
  publicKey: Buffer;
}

/**
 * Atomically consumes (deletes) at most one available one-time prekey for
 * a device via `DELETE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED
 * LIMIT 1) RETURNING *` — the standard Postgres atomic-queue-pop idiom.
 * Two concurrent callers racing this can never receive the same row: the
 * loser's subquery skips the locked row and finds the next one (or none).
 */
async function consumeOneTimePreKey(
  prisma: PrismaClient,
  deviceRowId: string,
): Promise<OneTimePreKeyRow | null> {
  const rows = await prisma.$queryRaw<OneTimePreKeyRow[]>(Prisma.sql`
    DELETE FROM one_time_prekeys
    WHERE id = (
      SELECT id FROM one_time_prekeys
      WHERE "deviceId" = ${deviceRowId}
      ORDER BY id ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "keyId", "publicKey"
  `);
  return rows[0] ?? null;
}

/** Builds a wire PreKeyBundlePublic for one active device, consuming one OTP if available. */
async function buildBundleForDevice(
  prisma: PrismaClient,
  device: Device,
): Promise<PreKeyBundlePublic | null> {
  const [signed, kyber] = await Promise.all([
    prisma.signedPreKey.findFirst({ where: { deviceId: device.id }, orderBy: { createdAt: "desc" } }),
    prisma.kyberPreKey.findFirst({ where: { deviceId: device.id }, orderBy: { createdAt: "desc" } }),
  ]);
  if (!signed || !kyber) return null; // device published identity but never finished prekey upload

  const otp = await consumeOneTimePreKey(prisma, device.id);

  return {
    userId: device.userId,
    deviceId: device.deviceId,
    registrationId: device.registrationId,
    identityKey: toBase64(device.identityKey),
    signedPreKeyId: signed.keyId,
    signedPreKeyPublic: toBase64(signed.publicKey),
    signedPreKeySignature: toBase64(signed.signature),
    ...(otp ? { preKeyId: otp.keyId, preKeyPublic: toBase64(otp.publicKey) } : {}),
    kyberPreKeyId: kyber.keyId,
    kyberPreKeyPublic: toBase64(kyber.publicKey),
    kyberPreKeySignature: toBase64(kyber.signature),
  };
}

/** Fetches bundle(s) for a user's device(s) — one specific device, or every active device. */
export async function fetchPreKeyBundles(
  prisma: PrismaClient,
  params: { userId: string; deviceId?: number },
): Promise<PreKeyBundlePublic[]> {
  const devices = await prisma.device.findMany({
    where: {
      userId: params.userId,
      replacedAt: null,
      ...(params.deviceId !== undefined ? { deviceId: params.deviceId } : {}),
    },
  });
  const bundles = await Promise.all(devices.map((d) => buildBundleForDevice(prisma, d)));
  return bundles.filter((b): b is PreKeyBundlePublic => b !== null);
}

/** Active (non-replaced) device ids currently registered for a user. */
export async function listActiveDeviceIds(prisma: PrismaClient, userId: string): Promise<number[]> {
  const devices = await prisma.device.findMany({
    where: { userId, replacedAt: null },
    select: { deviceId: true },
  });
  return devices.map((d) => d.deviceId);
}

// ---------------------------------------------------------------------------
// Conversations + membership
// ---------------------------------------------------------------------------

export async function createConversation(
  prisma: PrismaClient,
  params: { creatorUserId: string; memberUserIds: string[]; aiMode: boolean },
): Promise<string> {
  const memberIds = new Set(params.memberUserIds.filter((id) => id !== params.creatorUserId));
  return prisma.$transaction(async (tx) => {
    const conversation = await tx.conversation.create({
      data: {
        createdBy: params.creatorUserId,
        aiMode: params.aiMode ? "active" : "passive",
      },
    });
    await tx.membership.create({
      data: { conversationId: conversation.id, userId: params.creatorUserId, role: "admin" },
    });
    for (const memberId of memberIds) {
      await tx.membership.create({
        data: { conversationId: conversation.id, userId: memberId, role: "member" },
      });
    }
    return conversation.id;
  });
}

export async function isActiveMember(
  prisma: PrismaClient,
  conversationId: string,
  userId: string,
): Promise<boolean> {
  const membership = await prisma.membership.findFirst({
    where: { conversationId, userId, removedAt: null },
  });
  return membership !== null;
}

/** True if `userId` is the conversation's creator or an active admin member. */
export async function canManageMembership(
  prisma: PrismaClient,
  conversationId: string,
  userId: string,
): Promise<boolean> {
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!conversation) return false;
  if (conversation.createdBy === userId) return true;
  const membership = await prisma.membership.findFirst({
    where: { conversationId, userId, removedAt: null, role: "admin" },
  });
  return membership !== null;
}

/**
 * ============================================================================
 * RELAY-TRUSTED BOUNDARY: membership mutation.
 *
 * The relay is the sole authority on group membership (clients cannot see or
 * verify each other's membership state independently — Signal's "sender
 * keys"/group model delegates membership bookkeeping to the server). These
 * functions are called ONLY after route-level auth confirms the caller is
 * the conversation creator or an active admin member (canManageMembership).
 * A bug here is a membership-integrity bug for the whole conversation.
 * ============================================================================
 */
export async function inviteMember(
  prisma: PrismaClient,
  conversationId: string,
  userId: string,
): Promise<void> {
  const existing = await prisma.membership.findFirst({ where: { conversationId, userId } });
  if (existing) {
    await prisma.membership.update({
      where: { id: existing.id },
      data: { removedAt: null, role: existing.role === "admin" ? "admin" : "member" },
    });
    return;
  }
  await prisma.membership.create({ data: { conversationId, userId, role: "member" } });
}

export async function removeMember(
  prisma: PrismaClient,
  conversationId: string,
  userId: string,
): Promise<void> {
  await prisma.membership.updateMany({
    where: { conversationId, userId, removedAt: null },
    data: { removedAt: new Date() },
  });
}

export async function setAiMode(prisma: PrismaClient, conversationId: string, enabled: boolean): Promise<void> {
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { aiMode: enabled ? "active" : "passive" },
  });
}

/** Current AI mode for a conversation. `true` when `aiMode === "active"`. */
export async function getAiMode(prisma: PrismaClient, conversationId: string): Promise<boolean> {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { aiMode: true },
  });
  return conv?.aiMode === "active";
}

export interface MemberListEntry {
  userId: string;
  deviceIds: number[];
}

export async function listMembers(prisma: PrismaClient, conversationId: string): Promise<MemberListEntry[]> {
  const memberships = await prisma.membership.findMany({
    where: { conversationId, removedAt: null },
  });
  return Promise.all(
    memberships.map(async (m) => ({
      userId: m.userId,
      deviceIds: await listActiveDeviceIds(prisma, m.userId),
    })),
  );
}

/** All conversation ids `userId` is currently an active member of. */
export async function listActiveConversationIds(prisma: PrismaClient, userId: string): Promise<string[]> {
  const memberships = await prisma.membership.findMany({
    where: { userId, removedAt: null },
    select: { conversationId: true },
  });
  return memberships.map((m) => m.conversationId);
}

// ---------------------------------------------------------------------------
// Envelopes: ciphertext + routing metadata only, ever.
// ---------------------------------------------------------------------------

export interface StoredEnvelope {
  conversationId: string;
  recipientUserId: string;
  recipientDeviceId: number;
  senderUserId: string;
  senderDeviceId: number;
  seq: bigint;
  /** libsignal CiphertextMessageType (2 = Whisper, 3 = PreKey). */
  type: number;
  /** Raw ciphertext bytes as returned by Prisma for a `Bytes` column. */
  ciphertext: Uint8Array;
}

export async function enqueueEnvelope(
  prisma: PrismaClient,
  params: {
    conversationId: string;
    recipientUserId: string;
    recipientDeviceId: number;
    senderUserId: string;
    senderDeviceId: number;
    type: number;
    ciphertext: string; // base64, as received on the wire
  },
): Promise<StoredEnvelope> {
  const row = await prisma.envelope.create({
    data: {
      conversationId: params.conversationId,
      recipientUserId: params.recipientUserId,
      recipientDeviceId: params.recipientDeviceId,
      senderUserId: params.senderUserId,
      senderDeviceId: params.senderDeviceId,
      type: params.type,
      ciphertext: toBytes(params.ciphertext),
    },
  });
  return row;
}

/** Pending envelopes for one recipient device, ordered by seq for in-order delivery. */
export async function drainPendingEnvelopes(
  prisma: PrismaClient,
  params: { recipientUserId: string; recipientDeviceId: number; conversationIds: string[]; sinceSeq?: bigint },
): Promise<StoredEnvelope[]> {
  if (params.conversationIds.length === 0) return [];
  return prisma.envelope.findMany({
    where: {
      recipientUserId: params.recipientUserId,
      recipientDeviceId: params.recipientDeviceId,
      conversationId: { in: params.conversationIds },
      ...(params.sinceSeq !== undefined ? { seq: { gt: params.sinceSeq } } : {}),
    },
    orderBy: { seq: "asc" },
  });
}

/**
 * Deletion-on-ack IS the retention policy: a recipient device acks each
 * envelope by its own `seq` (see the client's `safeAck`), and that ack deletes
 * exactly that one envelope for the (conversation, device). There is no replay
 * buffer, and — critically — no cursor: an ack must NOT delete everything at or
 * below `seq`. `seq` is a single global autoincrement shared by every sender,
 * so one recipient's group mailbox interleaves seqs from multiple senders. A
 * range-delete (`seq <= acked`) would drop an earlier-seq envelope from a
 * *different* sender that the client simply hasn't processed yet (it drains its
 * inbox serially and acks per-envelope), silently losing a group message.
 * Anything the client never acks — e.g. an envelope it couldn't decrypt — stays
 * in the mailbox and is redelivered on the next drain (at-least-once until
 * acked).
 */
export async function ackEnvelopes(
  prisma: PrismaClient,
  params: { recipientUserId: string; recipientDeviceId: number; conversationId: string; seq: bigint },
): Promise<number> {
  const result = await prisma.envelope.deleteMany({
    where: {
      recipientUserId: params.recipientUserId,
      recipientDeviceId: params.recipientDeviceId,
      conversationId: params.conversationId,
      seq: params.seq,
    },
  });
  return result.count;
}
