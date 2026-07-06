/**
 * @signalai/membership — the founder-signed membership op-log (Plan 004 / design
 * §B.2, §F.2, §F.3, §F.4). Replaces relay-authoritative membership with a
 * single-author, hash-chained, signed operation log that every peer verifies
 * independently, plus the receiver-side enforcement gate that makes "removed ⇒
 * verifiably cannot participate" cryptographically real.
 *
 * Depends on `@signalai/core` (identity/signing primitives) and
 * `@signalai/proto` (wire shapes) ONLY — never the reverse (design §8).
 * INVENTS NO CRYPTO: libsignal identity-key signatures + SHA-256.
 */
export type { MembershipOp, UnsignedOp, OpType } from "./ops.js";
export { GENESIS_ZERO } from "./ops.js";
export {
  encodeOp,
  decodeOp,
  encodeForSigning,
  encodeForHashing,
  CanonicalError,
} from "./canonical.js";
export { signOp, verifyOpSig, hashOp, toHex, bytesEqual } from "./crypto.js";
export { verifyChain, fold, apply, headOf, IntegrityError, type Head } from "./chain.js";
export { MembershipLog, serializeInvitePin, parseInvitePin, type InvitePin } from "./log.js";
export { enforceInbound, type ChainProvider, type GateResult } from "./gate.js";
export {
  OpLogMembershipService,
  type MembershipServiceSeam,
  type OpBroadcaster,
} from "./service.js";
