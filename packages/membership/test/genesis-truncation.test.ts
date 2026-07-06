import { describe, expect, it } from "vitest";
import {
  headOf,
  IntegrityError,
  MembershipLog,
  toHex,
  hashOp,
  verifyChain,
  type InvitePin,
  type MembershipOp,
} from "../src/index.js";
import { append, genesis, makeIdentity } from "./helpers.js";

const founder = makeIdentity();
const cid = "conv-genesis";

/** create(F; B,C) → invite D (seq1) → remove C (seq2). */
function fullChain(): MembershipOp[] {
  const g = genesis({ founder, conversationId: cid, author: "F", initialMembers: ["B", "C"], aiMode: false });
  const invD = append([g], founder, { type: "invite", author: "F", subject: "D" });
  const rmC = append([g, invD], founder, { type: "remove", author: "F", subject: "C" });
  return [g, invD, rmC];
}

function pinAt(chain: MembershipOp[], seq: number): InvitePin {
  return {
    conversationId: cid,
    genesisHash: toHex(hashOp(chain[0]!)),
    pinnedHead: headOf(chain.slice(0, seq + 1)),
  };
}

describe("genesis bootstrap (design §4, §F.3)", () => {
  it("a fresh joiner verifies the re-sent chain against the invite-pin and computes the same set as existing peers", () => {
    const chain = fullChain();
    const existing = MembershipLog.open(chain).members();

    // Invite pins the head at the current tip (seq 2). Existing members re-send the full chain.
    const pin = pinAt(chain, 2);
    const joiner = MembershipLog.forJoiner(pin);
    joiner.ingestChain(chain);

    expect([...joiner.members()].sort()).toEqual([...existing].sort());
    expect([...joiner.members()].sort()).toEqual(["B", "D", "F"]);
  });

  it("rejects a re-sent chain whose genesis does not match the invite-pinned genesis hash", () => {
    const chain = fullChain();
    const badPin: InvitePin = { ...pinAt(chain, 2), genesisHash: "00".repeat(32) };
    const joiner = MembershipLog.forJoiner(badPin);
    expect(() => joiner.ingestChain(chain)).toThrow(/genesis/);
  });
});

describe("truncation / withholding resistance (design §5, §F.3)", () => {
  it("an INTERNALLY-VALID prefix that hides a later remove is itself well-formed (detection is NOT from malformation)", () => {
    const chain = fullChain();
    const prefix = chain.slice(0, 2); // [create, invite] — omits remove(C) at seq 2
    // The prefix passes verifyChain: correct signatures + hash links. It is valid, just not latest.
    expect(() => verifyChain(prefix)).not.toThrow();
  });

  it("a receiver past the prefix rejects it via the non-regressing watermark (§5.2)", () => {
    const chain = fullChain();
    const receiver = MembershipLog.open(chain); // watermark at seq 2 (has folded remove C)
    const prefix = chain.slice(0, 2); // hides remove(C)
    expect(() => receiver.ingestChain(prefix)).toThrow(/regress|watermark/);
    // And the receiver's view is unchanged: C stays removed.
    expect(receiver.members().has("C")).toBe(false);
  });

  it("a fresh joiner whose invite pinned a head past the prefix rejects it (invite-pin lower bound, §4)", () => {
    const chain = fullChain();
    const pin = pinAt(chain, 2); // invited at seq 2
    const joiner = MembershipLog.forJoiner(pin);
    const prefix = chain.slice(0, 2); // a malicious sole source serves only up to seq 1
    expect(() => joiner.ingestChain(prefix)).toThrow(IntegrityError);
  });
});
