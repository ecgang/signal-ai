import { describe, expect, it } from "vitest";
import {
  apply,
  GENESIS_ZERO,
  hashOp,
  IntegrityError,
  MembershipLog,
  verifyChain,
  type MembershipOp,
} from "../src/index.js";
import { append, genesis, makeIdentity, pub, signWith } from "./helpers.js";

describe("op-log integrity (design §3, §F.3)", () => {
  const founder = makeIdentity();
  const cid = "conv-integrity";

  function validChain(): MembershipOp[] {
    const g = genesis({ founder, conversationId: cid, author: "F", initialMembers: ["B", "C"], aiMode: false });
    const invD = append([g], founder, { type: "invite", author: "F", subject: "D" });
    const rmC = append([g, invD], founder, { type: "remove", author: "F", subject: "C" });
    return [g, invD, rmC];
  }

  it("folds a valid chain deterministically; three independent peers compute the identical set", () => {
    const chain = validChain();
    const p1 = apply(chain);
    const p2 = MembershipLog.open(chain).members();
    const p3 = MembershipLog.open([...chain]).members();
    expect([...p1.members].sort()).toEqual(["B", "D", "F"]);
    expect([...p2].sort()).toEqual([...p1.members].sort());
    expect([...p3].sort()).toEqual([...p1.members].sort());
    expect(p1.aiMode).toBe(false);
  });

  it("rejects a dense-seq gap (missing seq is an integrity failure, §F.3)", () => {
    const g = genesis({ founder, conversationId: cid, author: "F", initialMembers: ["B"], aiMode: false });
    // Craft an op whose seq jumps to 2, skipping 1, but still hash-links to genesis.
    const skip = signWith(founder, {
      type: "invite", conversationId: cid, seq: 2, prevHash: hashOp(g), author: "F",
      subject: "C", aiMode: null, initialMembers: null, authorIdentityKey: pub(founder),
    });
    expect(() => verifyChain([g, skip])).toThrow(IntegrityError);
  });

  it("rejects an op signed by a different (attacker) key — key-pinning (§7)", () => {
    const attacker = makeIdentity();
    const g = genesis({ founder, conversationId: cid, author: "F", initialMembers: ["B"], aiMode: false });
    // Attacker authors a remove with THEIR OWN key + a valid signature over it.
    const forged = append([g], attacker, {
      type: "remove", author: "F", subject: "B", authorIdentityKey: pub(attacker),
    });
    expect(() => verifyChain([g, forged])).toThrow(/key-pinning/);
  });

  it("rejects an op claiming the founder key but signed by the attacker — invalid signature", () => {
    const attacker = makeIdentity();
    const g = genesis({ founder, conversationId: cid, author: "F", initialMembers: ["B"], aiMode: false });
    // Claims founder's key but the signature is the attacker's → signature verify fails.
    const forged = append([g], attacker, {
      type: "remove", author: "F", subject: "B", authorIdentityKey: pub(founder),
    });
    expect(() => verifyChain([g, forged])).toThrow(/invalid signature/);
  });

  it("rejects a cross-conversation replay (op bound to a foreign conversationId)", () => {
    const g = genesis({ founder, conversationId: cid, author: "F", initialMembers: ["B"], aiMode: false });
    // A validly-signed op, but bound to conversation "OTHER" and spliced into this chain.
    const foreign = append([g], founder, { type: "invite", author: "F", subject: "C", conversationId: "OTHER" });
    expect(() => verifyChain([g, foreign])).toThrow(/foreign conversationId/);
  });

  it("rejects a tampered prevHash (broken chain link)", () => {
    const chain = validChain();
    const tampered = [...chain];
    const bad = { ...tampered[1]!, prevHash: new Uint8Array(32).fill(9) };
    tampered[1] = bad;
    expect(() => verifyChain(tampered)).toThrow(IntegrityError);
  });

  it("rejects a genesis that is not a create-at-seq-0 with the genesis-zero prevHash", () => {
    const g = genesis({ founder, conversationId: cid, author: "F", initialMembers: [], aiMode: false });
    const notGenesis = { ...g, prevHash: new Uint8Array(32).fill(1) };
    expect(() => verifyChain([notGenesis])).toThrow(IntegrityError);
    expect(GENESIS_ZERO.every((b) => b === 0)).toBe(true);
  });
});
