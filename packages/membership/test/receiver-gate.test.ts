import { describe, expect, it } from "vitest";
import type { MembershipHead } from "@signalai/proto";
import { enforceInbound, headOf, MembershipLog, type MembershipOp } from "../src/index.js";
import { append, genesis, makeIdentity } from "./helpers.js";

const founder = makeIdentity();
const cid = "conv-gate";

/** create(F; B,C) at seq0 → remove(C) at seq1. R = 1. */
function chainWithRemove(): { chain: MembershipOp[]; R: number } {
  const g = genesis({ founder, conversationId: cid, author: "F", initialMembers: ["B", "C"], aiMode: false });
  const rmC = append([g], founder, { type: "remove", author: "F", subject: "C" });
  return { chain: [g, rmC], R: 1 };
}

function headAt(chain: MembershipOp[], seq: number): MembershipHead {
  return headOf(chain.slice(0, seq + 1));
}

describe("receiver-side enforcement gate (design §6, §F.2)", () => {
  it("F.2 receiver-drop: an INDEPENDENT receiver that folded remove(C) drops C's message (not merely sender omission)", () => {
    const { chain, R } = chainWithRemove();
    const receiver = MembershipLog.open(chain); // H_recv = R; C already removed
    // C emits a message citing the current head (>= R). The receiver — not the sender — rejects it.
    const verdict = enforceInbound(receiver, "C", headAt(chain, R));
    expect(verdict.accepted).toBe(false);
    expect(verdict.reason).toMatch(/not a member/);
    // A still-present member is accepted at the same head.
    expect(enforceInbound(receiver, "B", headAt(chain, R)).accepted).toBe(true);
  });

  it("F.2 fail-closed: a message with NO membershipHead (old-client shape) is rejected", () => {
    const { chain } = chainWithRemove();
    const receiver = MembershipLog.open(chain);
    const verdict = enforceInbound(receiver, "B", undefined);
    expect(verdict.accepted).toBe(false);
    expect(verdict.reason).toMatch(/no membershipHead|fail-closed/);
  });

  it("closes C2: a cited headHash that does not match the receiver's verified chain is rejected", () => {
    const { chain, R } = chainWithRemove();
    const receiver = MembershipLog.open(chain);
    const forgedHead: MembershipHead = { seq: R, headHash: "ff".repeat(32) };
    const verdict = enforceInbound(receiver, "B", forgedHead);
    expect(verdict.accepted).toBe(false);
    expect(verdict.reason).toMatch(/does not match/);
  });

  it("stale-head-citation replay (C3): removed C cites a VALID pre-removal head R-1; receiver at H_recv >= R REJECTS", () => {
    const { chain, R } = chainWithRemove();
    const receiver = MembershipLog.open(chain); // H_recv = R
    const preRemovalHead = headAt(chain, R - 1); // seq 0: correct headHash, C ∈ fold(≤ R-1)
    // Sanity: the cited head really is a valid pre-removal head where C was a member.
    expect(MembershipLog.open(chain.slice(0, R)).members().has("C")).toBe(true);

    const verdict = enforceInbound(receiver, "C", preRemovalHead);
    expect(verdict.accepted).toBe(false);
    expect(verdict.reason).toMatch(/not a member/); // authorized at H_recv, NOT the cited head
  });

  it("stale-head-citation MIRROR: a receiver still at H_recv = R-1 ACCEPTS the same message (honest cold-window boundary)", () => {
    const { chain, R } = chainWithRemove();
    const behind = MembershipLog.open(chain.slice(0, R)); // H_recv = R-1, has NOT folded remove(C)
    const preRemovalHead = headAt(chain, R - 1);
    const verdict = enforceInbound(behind, "C", preRemovalHead);
    expect(verdict.accepted).toBe(true); // C is still a member at this receiver's own head — not a bug
  });

  it("F.2 propagation-race: verdict is deterministic in the receiver's OWN head, not the cited head", () => {
    const { chain, R } = chainWithRemove();
    const advanced = MembershipLog.open(chain); // folded remove(C)
    const behind = MembershipLog.open(chain.slice(0, R)); // has not

    // Same message from C, whatever head it cites: advanced rejects, behind accepts — pinned to H_recv.
    for (const cited of [headAt(chain, R - 1), headAt(chain, R)]) {
      // `behind` can only evaluate heads it can reach; for the R head it would need catch-up (tested below).
      if (cited.seq <= R - 1) {
        expect(enforceInbound(behind, "C", cited).accepted).toBe(true);
      }
      expect(enforceInbound(advanced, "C", cited).accepted).toBe(false);
    }
  });

  it("F.2 catch-up: a lazy receiver behind the cited head re-requests, advances H_recv past remove(C), then rejects", () => {
    const { chain, R } = chainWithRemove();
    const lazy = MembershipLog.open(chain.slice(0, R)); // H_recv = R-1
    const citedAtR = headAt(chain, R); // beyond the lazy receiver's head → triggers catch-up
    const provider = (h: MembershipHead): MembershipOp[] | undefined =>
      h.seq <= R ? chain.slice(0, R + 1) : undefined;

    const verdict = enforceInbound(lazy, "C", citedAtR, provider);
    expect(verdict.accepted).toBe(false);
    expect(verdict.reason).toMatch(/not a member/);
    // The catch-up advanced the receiver's head to R.
    expect(lazy.head().seq).toBe(R);
  });
});
