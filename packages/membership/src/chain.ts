import { GENESIS_ZERO, type MembershipOp } from "./ops.js";
import { bytesEqual, hashOp, toHex, verifyOpSig } from "./crypto.js";

/** Raised (fail-closed) by `verifyChain` on any integrity violation. */
export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrityError";
  }
}

/** A membership head: a log position plus the lowercase-hex hash of the op there. */
export interface Head {
  seq: number;
  headHash: string;
}

/**
 * Validates that an op's payload fields are shaped correctly for its type.
 * A forged op that, say, smuggles an `initialMembers` payload into an `invite`
 * is rejected here before it can affect a fold.
 */
function validateOpShape(op: MembershipOp): void {
  const bad = (why: string): never => {
    throw new IntegrityError(`malformed ${op.type} op at seq ${op.seq}: ${why}`);
  };
  switch (op.type) {
    case "create":
      if (op.subject !== null) bad("subject must be null");
      if (op.aiMode === null) bad("aiMode is required");
      if (op.initialMembers === null) bad("initialMembers is required");
      break;
    case "invite":
    case "remove":
      if (op.subject === null) bad("subject is required");
      if (op.aiMode !== null) bad("aiMode must be null");
      if (op.initialMembers !== null) bad("initialMembers must be null");
      break;
    case "setAiMode":
      if (op.subject !== null) bad("subject must be null");
      if (op.aiMode === null) bad("aiMode is required");
      if (op.initialMembers !== null) bad("initialMembers must be null");
      break;
    default:
      bad("unknown op type");
  }
}

/**
 * Verifies a totally-ordered op chain (design §3). Any failure throws
 * `IntegrityError` (fail-closed, never a partial result). Checks, per op:
 *   - genesis is a `create` at seq 0 with the all-zero `prevHash`;
 *   - `conversationId` matches genesis (cross-conversation replay rejected);
 *   - `seq` is dense 0,1,2,… (a gap is an integrity failure, §F.3);
 *   - `prevHash == H(canonical(prev op))` (chain linkage);
 *   - the signature verifies against the op's `authorIdentityKey`;
 *   - `author` equals the genesis author (single-writer, §1);
 *   - `authorIdentityKey` equals the genesis authority key (key-pinning, §7 —
 *     a forged op signed with a *different* valid key is rejected).
 */
export function verifyChain(log: readonly MembershipOp[]): void {
  if (log.length === 0) throw new IntegrityError("empty log");
  const genesis = log[0]!;
  if (genesis.type !== "create") throw new IntegrityError("genesis is not a create op");
  if (genesis.seq !== 0) throw new IntegrityError("genesis seq is not 0");
  if (!bytesEqual(genesis.prevHash, GENESIS_ZERO)) throw new IntegrityError("genesis prevHash is not the genesis-zero hash");

  const founderKey = genesis.authorIdentityKey;
  const founderAuthor = genesis.author;
  const conversationId = genesis.conversationId;

  for (let i = 0; i < log.length; i++) {
    const op = log[i]!;
    validateOpShape(op);
    if (op.conversationId !== conversationId) throw new IntegrityError(`op at seq ${i} has a foreign conversationId`);
    if (op.seq !== i) throw new IntegrityError(`op at index ${i} has seq ${op.seq} (dense-seq violation)`);
    if (i === 0) {
      if (!bytesEqual(op.prevHash, GENESIS_ZERO)) throw new IntegrityError("genesis prevHash is not the genesis-zero hash");
    } else {
      if (!bytesEqual(op.prevHash, hashOp(log[i - 1]!))) throw new IntegrityError(`op at seq ${i} breaks the hash chain`);
    }
    if (!verifyOpSig(op)) throw new IntegrityError(`op at seq ${i} has an invalid signature`);
    if (i > 0) {
      if (op.author !== founderAuthor) throw new IntegrityError(`op at seq ${i} has a non-founder author (single-writer violation)`);
      if (!bytesEqual(op.authorIdentityKey, founderKey)) throw new IntegrityError(`op at seq ${i} is signed by a non-authority key (key-pinning violation)`);
    }
  }
}

/**
 * Pure deterministic fold of a VERIFIED chain into the current member set and
 * AI-mode (design §3). Assumes `verifyChain` already passed; call {@link apply}
 * to do both. Every honest peer with the same prefix computes the identical set.
 */
export function fold(log: readonly MembershipOp[]): { members: Set<string>; aiMode: boolean } {
  const genesis = log[0]!;
  let members = new Set<string>();
  let aiMode = false;
  for (const op of log) {
    switch (op.type) {
      case "create":
        members = new Set<string>([genesis.author, ...(op.initialMembers ?? [])]);
        aiMode = op.aiMode ?? false;
        break;
      case "invite":
        if (op.subject !== null) members.add(op.subject);
        break;
      case "remove":
        if (op.subject !== null) members.delete(op.subject);
        break;
      case "setAiMode":
        aiMode = op.aiMode ?? false;
        break;
    }
  }
  return { members, aiMode };
}

/** Verifies then folds a chain (design §3). Throws `IntegrityError` on any violation. */
export function apply(log: readonly MembershipOp[]): { members: Set<string>; aiMode: boolean } {
  verifyChain(log);
  return fold(log);
}

/** The head of a chain: the highest-seq op's position and hash. Chain must be non-empty. */
export function headOf(log: readonly MembershipOp[]): Head {
  const last = log[log.length - 1]!;
  return { seq: last.seq, headHash: toHex(hashOp(last)) };
}
