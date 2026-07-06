import type { MembershipOp } from "./ops.js";
import { hashOp, toHex } from "./crypto.js";
import { fold, headOf, IntegrityError, verifyChain, type Head } from "./chain.js";

/** The out-of-band invite payload (design §4): a trusted lower bound for a fresh joiner. */
export interface InvitePin {
  conversationId: string;
  /** `H(canonical(genesis op))` captured at invite time. */
  genesisHash: string;
  /** The `(seq, headHash)` the joiner was invited at — it can never be rewound below this. */
  pinnedHead: Head;
}

/**
 * A peer's local view of one conversation's membership op-log, with the
 * PREREQ-2 latestness machinery (design §5):
 *
 *  - It holds the highest VERIFIED chain it has adopted.
 *  - `watermark` is the highest authenticated head it has ever seen; it NEVER
 *    regresses below it. A candidate chain whose head is behind the watermark
 *    is rejected — no quorum needed (§5.2 non-regression).
 *  - A joiner constructed with an {@link InvitePin} starts with `watermark` =
 *    the invite-pinned head and additionally requires every adopted chain to
 *    contain the pinned genesis hash and pinned `(seq, headHash)` (§4 TOFU
 *    lower bound).
 *
 * Signatures + hash-chain prove a log is *internally valid*, not *latest*; this
 * is the mechanism that makes a hidden-later-`remove` prefix detectable.
 */
export class MembershipLog {
  private ops: MembershipOp[] = [];
  private watermark: Head | null;

  private constructor(
    readonly conversationId: string,
    private readonly pin: InvitePin | null,
  ) {
    this.watermark = pin ? pin.pinnedHead : null;
  }

  /** Opens a log from an existing verified chain (an existing member / the founder). */
  static open(chain: readonly MembershipOp[]): MembershipLog {
    const genesis = chain[0];
    if (!genesis) throw new IntegrityError("cannot open an empty chain");
    const log = new MembershipLog(genesis.conversationId, null);
    log.ingestChain(chain);
    return log;
  }

  /**
   * Creates a fresh joiner's log from an out-of-band invite (design §4). The
   * log starts empty and MUST be given the full chain via {@link ingestChain}
   * (the genesis re-send) before it can fold members.
   */
  static forJoiner(pin: InvitePin): MembershipLog {
    return new MembershipLog(pin.conversationId, pin);
  }

  /**
   * Verifies a candidate chain and adopts it if it validly extends (or equals)
   * the current view. Enforces (design §5):
   *   - conversation binding;
   *   - invite-pin: the pinned genesis + pinned `(seq, headHash)` must appear
   *     in the candidate (joiner only);
   *   - non-regression: the candidate must reach at least the watermark and
   *     agree with the watermark hash at the watermark's seq (no fork, no
   *     rewind below the highest authenticated head ever seen).
   * Throws `IntegrityError` on any violation; never adopts a partial/invalid chain.
   */
  ingestChain(candidate: readonly MembershipOp[]): void {
    verifyChain(candidate);
    const genesis = candidate[0]!;
    if (genesis.conversationId !== this.conversationId) {
      throw new IntegrityError("candidate chain is for a different conversation");
    }

    if (this.pin) {
      if (toHex(hashOp(genesis)) !== this.pin.genesisHash) {
        throw new IntegrityError("candidate genesis does not match the invite-pinned genesis hash");
      }
      const pinnedOp = candidate[this.pin.pinnedHead.seq];
      if (!pinnedOp || toHex(hashOp(pinnedOp)) !== this.pin.pinnedHead.headHash) {
        throw new IntegrityError("candidate does not contain the invite-pinned head (truncated below invite)");
      }
    }

    const candHead = headOf(candidate);
    if (this.watermark) {
      if (candHead.seq < this.watermark.seq) {
        throw new IntegrityError("candidate head regresses below the non-regressing watermark (truncated prefix)");
      }
      const opAtWatermark = candidate[this.watermark.seq];
      if (!opAtWatermark || toHex(hashOp(opAtWatermark)) !== this.watermark.headHash) {
        throw new IntegrityError("candidate diverges from the watermark (fork)");
      }
    }

    // Adopt only a chain at least as long as the one we hold, and advance the
    // watermark monotonically to the newly-verified head.
    if (candHead.seq >= (this.ops.length ? this.ops[this.ops.length - 1]!.seq : -1)) {
      this.ops = [...candidate];
    }
    if (!this.watermark || candHead.seq > this.watermark.seq) {
      this.watermark = candHead;
    }
  }

  /** The receiver's OWN current verified head `H_recv`. Throws if no chain has been adopted yet. */
  head(): Head {
    if (this.ops.length === 0) {
      if (this.watermark) return this.watermark;
      throw new IntegrityError("log has no verified chain yet");
    }
    return headOf(this.ops);
  }

  /** Whether any verified chain has been adopted (folding is possible). */
  get ready(): boolean {
    return this.ops.length > 0;
  }

  /** The op at `seq` in the verified chain, or `undefined` if beyond the current head. */
  opAt(seq: number): MembershipOp | undefined {
    return this.ops[seq];
  }

  /** The current member set folded at `H_recv` (design §3/§6 — authorization vantage point). */
  members(): Set<string> {
    if (this.ops.length === 0) throw new IntegrityError("cannot fold an unpopulated log");
    return fold(this.ops).members;
  }

  /** The current AI-mode folded at `H_recv`. */
  aiMode(): boolean {
    if (this.ops.length === 0) throw new IntegrityError("cannot fold an unpopulated log");
    return fold(this.ops).aiMode;
  }

  /** A copy of the verified chain — used for genesis re-send to a joiner (design §4). */
  chain(): MembershipOp[] {
    return [...this.ops];
  }
}
