import type { MembershipHead } from "@signalai/proto";
import type { MembershipOp } from "./ops.js";
import { hashOp, toHex } from "./crypto.js";
import { IntegrityError } from "./chain.js";
import type { MembershipLog } from "./log.js";

/**
 * Supplies a fuller verified chain up to at least `citedHead` when a receiver
 * discovers it is behind (design §5.3 catch-up / §6 step 2). Returns
 * `undefined` if no such chain can be produced.
 */
export type ChainProvider = (citedHead: MembershipHead) => readonly MembershipOp[] | undefined;

/** The gate verdict. `accepted: false` always carries a `reason` for observability. */
export interface GateResult {
  accepted: boolean;
  reason?: string;
}

function reject(reason: string): GateResult {
  return { accepted: false, reason };
}

/**
 * The receiver-side enforcement gate (design §6) — the negative, load-bearing
 * invariant. Run on every inbound message AFTER ratchet decrypt. Authorizes the
 * sender using the RECEIVER'S OWN current verified head `H_recv`, NEVER the
 * sender-cited head. Rejects unless ALL hold:
 *
 *   1. `citedHead` is present — an absent membershipHead is a fail-closed
 *      REJECT (old-client shape; optional-parse ≠ default-accept, §6/PREREQ-1).
 *   2. The cited head matches the receiver's verified chain at that seq (closes
 *      C2). If the receiver is behind the cited seq it CATCHES UP first
 *      (re-request + verify, advancing `H_recv`) before re-evaluating; a cited
 *      head that never matches the receiver's chain is rejected.
 *   3. The sender is in `fold(receiver_chain ≤ H_recv).members` — authorization
 *      resolved at the receiver's OWN head, NEVER the cited head (closes C3).
 *
 * Why not the cited head: a removed peer would cite an old still-valid
 * pre-removal head forever and pass a `fold(≤ cited)` check. Folding at the
 * receiver's own current head defeats that — once the receiver has folded
 * `remove(C)`, `C ∉ fold(≤ H_recv)`, so every message from C is rejected no
 * matter which head it cites.
 */
export function enforceInbound(
  log: MembershipLog,
  senderUserId: string,
  citedHead: MembershipHead | undefined,
  chainProvider?: ChainProvider,
): GateResult {
  // (1) fail-closed on a missing head reference.
  if (!citedHead) return reject("no membershipHead on message (fail-closed reject)");

  if (!log.ready) {
    // Cannot authorize without a verified chain; try to bootstrap from the cited head.
    const fuller = chainProvider?.(citedHead);
    if (!fuller) return reject("receiver has no verified chain and no catch-up source");
    try {
      log.ingestChain(fuller);
    } catch (e) {
      return reject(`catch-up chain failed verification: ${(e as Error).message}`);
    }
  }

  // (2) If the receiver is behind the cited head, catch up before evaluating.
  if (citedHead.seq > log.head().seq) {
    const fuller = chainProvider?.(citedHead);
    if (!fuller) return reject("message cites a head beyond H_recv and no catch-up source is available");
    try {
      log.ingestChain(fuller);
    } catch (e) {
      return reject(`catch-up chain failed verification: ${(e as Error).message}`);
    }
    if (citedHead.seq > log.head().seq) return reject("still behind the cited head after catch-up");
  }

  // (2 cont.) The cited head must match the receiver's verified chain at that seq.
  const opAtCited = log.opAt(citedHead.seq);
  if (!opAtCited) return reject("cited seq is not present in the verified chain");
  if (toHex(hashOp(opAtCited)) !== citedHead.headHash) {
    return reject("cited headHash does not match the receiver's verified chain (forged/foreign head)");
  }

  // (3) Authorize at H_recv — the receiver's OWN current head, never the cited head.
  if (!log.members().has(senderUserId)) {
    return reject(`sender "${senderUserId}" is not a member as of H_recv (removed/never-added)`);
  }

  return { accepted: true };
}

export { IntegrityError };
