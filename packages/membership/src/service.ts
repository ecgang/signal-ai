import { randomUUID } from "node:crypto";
import type { Identity } from "@signalai/core";
import type { ConversationMember } from "@signalai/proto";
import { GENESIS_ZERO, type MembershipOp, type OpType, type UnsignedOp } from "./ops.js";
import { hashOp, signOp } from "./crypto.js";
import { headOf, IntegrityError, type Head } from "./chain.js";
import { encodeOp } from "./canonical.js";
import { MembershipLog, type InvitePin } from "./log.js";

/**
 * The membership seam this impl satisfies — a STRUCTURAL mirror of
 * `MembershipService` in `@signalai/client-sdk`'s `transport.ts` (~line 73).
 * It is re-declared here rather than imported so `@signalai/membership` keeps
 * its dependency direction lock (core + proto only; never client-sdk — design
 * §8). The shapes are identical, so a `SignalAiClient` consumes this impl by
 * structural typing.
 *
 * The `token` parameter is VESTIGIAL in P2P (there are no bearer tokens) — the
 * impl keeps the signature for seam compatibility and ignores it.
 */
export interface MembershipServiceSeam {
  createConversation(
    token: string,
    req: { creatorUserId: string; memberUserIds: string[]; aiMode: boolean },
  ): Promise<string>;
  invite(token: string, conversationId: string, userId: string): Promise<void>;
  removeMember(token: string, conversationId: string, userId: string): Promise<void>;
  setAiMode(token: string, conversationId: string, enabled: boolean): Promise<void>;
  listMembers(
    token: string,
    conversationId: string,
  ): Promise<{ members: ConversationMember[]; aiMode: boolean }>;
}

/**
 * Broadcasts a newly-signed op to the other peers (design §8 — the impl fans
 * ops over a Phase-2 `MessageTransport`). Kept as a narrow injected seam so the
 * op-log is testable without a live socket; the concrete socket wiring binds in
 * the client-sdk P2P transport.
 */
export interface OpBroadcaster {
  broadcastOp(conversationId: string, encodedOp: Uint8Array): void | Promise<void>;
}

/**
 * The founder-side membership authority over the signed op-log (design §1, §8).
 * Holds the authority-device `Identity`, appends signed ops to a single-author
 * hash-chain, and folds the chain to the current member set. Because it is the
 * single writer, `apply` stays a well-defined fold with no quorum.
 */
export class OpLogMembershipService implements MembershipServiceSeam {
  private readonly chains = new Map<string, MembershipOp[]>();
  private readonly logs = new Map<string, MembershipLog>();

  constructor(
    private readonly identity: Identity,
    private readonly selfUserId: string,
    private readonly broadcaster?: OpBroadcaster,
  ) {}

  private get authorKey(): Uint8Array {
    return this.identity.keyPair.publicKey.serialize();
  }

  private sign(unsigned: UnsignedOp): MembershipOp {
    return { ...unsigned, sig: signOp(unsigned, this.identity.keyPair.privateKey) };
  }

  async createConversation(
    _token: string,
    req: { creatorUserId: string; memberUserIds: string[]; aiMode: boolean },
  ): Promise<string> {
    const conversationId = randomUUID();
    const op = this.sign({
      type: "create",
      conversationId,
      seq: 0,
      prevHash: GENESIS_ZERO,
      author: req.creatorUserId,
      subject: null,
      aiMode: req.aiMode,
      initialMembers: [...req.memberUserIds],
      authorIdentityKey: this.authorKey,
    });
    this.chains.set(conversationId, [op]);
    this.logs.set(conversationId, MembershipLog.open([op]));
    await this.broadcaster?.broadcastOp(conversationId, encodeOp(op));
    return conversationId;
  }

  private async append(
    conversationId: string,
    fields: { type: OpType; subject: string | null; aiMode: boolean | null; initialMembers: string[] | null },
  ): Promise<void> {
    const chain = this.chains.get(conversationId);
    if (!chain || chain.length === 0) throw new IntegrityError(`unknown conversation ${conversationId}`);
    const prev = chain[chain.length - 1]!;
    const op = this.sign({
      type: fields.type,
      conversationId,
      seq: prev.seq + 1,
      prevHash: hashOp(prev),
      author: this.selfUserId,
      subject: fields.subject,
      aiMode: fields.aiMode,
      initialMembers: fields.initialMembers,
      authorIdentityKey: this.authorKey,
    });
    const next = [...chain, op];
    // Re-verify + advance the local view (also validates the founder is the writer).
    this.logs.get(conversationId)!.ingestChain(next);
    this.chains.set(conversationId, next);
    await this.broadcaster?.broadcastOp(conversationId, encodeOp(op));
  }

  invite(_token: string, conversationId: string, userId: string): Promise<void> {
    return this.append(conversationId, { type: "invite", subject: userId, aiMode: null, initialMembers: null });
  }

  removeMember(_token: string, conversationId: string, userId: string): Promise<void> {
    return this.append(conversationId, { type: "remove", subject: userId, aiMode: null, initialMembers: null });
  }

  setAiMode(_token: string, conversationId: string, enabled: boolean): Promise<void> {
    return this.append(conversationId, { type: "setAiMode", subject: null, aiMode: enabled, initialMembers: null });
  }

  async listMembers(
    _token: string,
    conversationId: string,
  ): Promise<{ members: ConversationMember[]; aiMode: boolean }> {
    const log = this.logs.get(conversationId);
    if (!log) throw new IntegrityError(`unknown conversation ${conversationId}`);
    // The op-log governs userId membership; per-device ids are resolved by the
    // directory plane (P3), so `deviceIds` is left empty here.
    const members: ConversationMember[] = [...log.members()].map((userId) => ({ userId, deviceIds: [] }));
    return { members, aiMode: log.aiMode() };
  }

  /** The current signed chain for `conversationId` — used for genesis re-send to a joiner (design §4). */
  chainFor(conversationId: string): MembershipOp[] {
    const chain = this.chains.get(conversationId);
    if (!chain) throw new IntegrityError(`unknown conversation ${conversationId}`);
    return [...chain];
  }

  /** The current verified head for `conversationId` (for stamping onto outbound messages, PREREQ-1). */
  headFor(conversationId: string): Head {
    const chain = this.chains.get(conversationId);
    if (!chain || chain.length === 0) throw new IntegrityError(`unknown conversation ${conversationId}`);
    return headOf(chain);
  }

  /** Builds the out-of-band invite pin (genesis hash + current head) for a new joiner (design §4). */
  inviteFor(conversationId: string): InvitePin {
    const chain = this.chains.get(conversationId);
    if (!chain || chain.length === 0) throw new IntegrityError(`unknown conversation ${conversationId}`);
    return {
      conversationId,
      genesisHash: Buffer.from(hashOp(chain[0]!)).toString("hex"),
      pinnedHead: headOf(chain),
    };
  }
}
