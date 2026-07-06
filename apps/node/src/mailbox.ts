import type { PrismaClient } from "@prisma/client";
import { enqueueEnvelope, drainPendingEnvelopes, ackEnvelopes, type StoredEnvelope } from "./db.js";

/**
 * Plan 003 (P1 node demotion) — ciphertext-only store-and-forward mailbox.
 *
 * `MailboxService` is the one piece of `apps/node` that design
 * docs/design/p2p-transport.md §B.3 means by "blind peer": it stores and
 * forwards opaque envelope bytes and NEVER parses, decodes, or inspects the
 * `ciphertext` field as an `EnvelopeSchema`/`PlaintextMessage` body, and it
 * never itself reads group membership. Its three operations
 * (`store`/`drain`/`ack`) are pass-throughs onto the same
 * `enqueueEnvelope`/`drainPendingEnvelopes`/`ackEnvelopes` Postgres queries
 * the relay always used (db.ts) — the per-device per-seq exact-ack
 * invariant (the "golden-flake-fix", see memory
 * `signal-ai-client-sdk-delivery`) is preserved verbatim, byte-for-byte.
 *
 * What it is NOT: an authority. Callers (src/index.ts) decide WHICH
 * conversationIds/recipient a store/drain/ack call may touch — that
 * decision is made by the fenced membership-authority checks
 * (`// AUTHORITY — removed in P2 (Plan 004)`) BEFORE calling into this
 * class. `MailboxService` itself takes that scope as a parameter and never
 * queries membership on its own. This class is ciphertext-blind today; the
 * node as a whole is not yet a "blind peer" end to end, because the
 * membership-authority code that gates it is fenced, not deleted (Plan 004
 * deletes it once the signed op-log is authoritative). Do not add a
 * membership read here — that is exactly the tripwire the design doc's
 * maintenance note warns about.
 *
 * Never logs `ciphertext` or any envelope field (this app already runs
 * Fastify with `logger: false` and never logs message bodies at any level).
 */
export class MailboxService {
  constructor(private readonly prisma: PrismaClient) {}

  /** Stores one opaque ciphertext envelope for later delivery. Never inspects `ciphertext`. */
  store(params: Parameters<typeof enqueueEnvelope>[1]): Promise<StoredEnvelope> {
    return enqueueEnvelope(this.prisma, params);
  }

  /**
   * Returns pending envelopes for one recipient device, ordered by seq for
   * in-order delivery. `conversationIds` is supplied by the caller's
   * (fenced) membership check — this method does not decide scope itself.
   */
  drain(params: Parameters<typeof drainPendingEnvelopes>[1]): Promise<StoredEnvelope[]> {
    return drainPendingEnvelopes(this.prisma, params);
  }

  /** Deletes exactly the envelope at (recipient, conversation, seq) — the per-seq exact-once ack invariant. */
  ack(params: Parameters<typeof ackEnvelopes>[1]): Promise<number> {
    return ackEnvelopes(this.prisma, params);
  }
}
