/**
 * The signed, hash-chained membership operation (design §2).
 *
 * A single-author log: for the v1 MVP only the conversation founder's
 * *authority device* (the identity that signed genesis) may sign
 * `invite` / `remove` / `setAiMode` ops (design §1). That makes the log a
 * single-author hash-chain whose total order is just the founder's own signed
 * `seq` sequence — no quorum, no consensus.
 */
export type OpType = "create" | "invite" | "remove" | "setAiMode";

/** A membership op with all fields, in the fixed canonical field order (design §2). */
export interface MembershipOp {
  /** Op kind. */
  type: OpType;
  /** Bound into every op; a cross-conversation replay is rejected by `verifyChain`. */
  conversationId: string;
  /** Dense position 0,1,2,… — a gap is an integrity failure (design §F.3). */
  seq: number;
  /** `H(canonical(op[seq-1]))`; the genesis op uses the all-zero 32-byte hash. */
  prevHash: Uint8Array;
  /** userId of the author — equals the genesis author for every non-genesis op (single-writer). */
  author: string;
  /** userId added/removed; `null` for `create`/`setAiMode`. */
  subject: string | null;
  /** AI-mode payload for `create`/`setAiMode`; `null` otherwise. */
  aiMode: boolean | null;
  /** Initial member userIds for `create`; `null` otherwise. */
  initialMembers: string[] | null;
  /** The serialized libsignal identity public key the signature verifies against. */
  authorIdentityKey: Uint8Array;
  /** libsignal identity-key signature over `canonical(all fields above except sig)`. */
  sig: Uint8Array;
}

/** An op without its signature — the shape signed to produce a {@link MembershipOp}. */
export type UnsignedOp = Omit<MembershipOp, "sig">;

/** The all-zero 32-byte hash used as the genesis op's `prevHash` (design §2). */
export const GENESIS_ZERO: Uint8Array = new Uint8Array(32);
