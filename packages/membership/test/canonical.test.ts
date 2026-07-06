import { describe, expect, it } from "vitest";
import { CanonicalError, decodeOp, encodeForHashing, encodeOp, hashOp, toHex, type MembershipOp } from "../src/index.js";
import { genesis, makeIdentity, pub, signWith } from "./helpers.js";

describe("canonical encoding (design §7)", () => {
  const founder = makeIdentity();
  const cid = "conv-canon";

  function opOfEachType(): MembershipOp[] {
    const create = genesis({ founder, conversationId: cid, author: "F", initialMembers: ["A", "B"], aiMode: true });
    const invite = signWith(founder, {
      type: "invite", conversationId: cid, seq: 1, prevHash: hashOp(create), author: "F",
      subject: "C", aiMode: null, initialMembers: null, authorIdentityKey: pub(founder),
    });
    const remove = signWith(founder, {
      type: "remove", conversationId: cid, seq: 2, prevHash: hashOp(invite), author: "F",
      subject: "C", aiMode: null, initialMembers: null, authorIdentityKey: pub(founder),
    });
    const setAi = signWith(founder, {
      type: "setAiMode", conversationId: cid, seq: 3, prevHash: hashOp(remove), author: "F",
      subject: null, aiMode: false, initialMembers: null, authorIdentityKey: pub(founder),
    });
    return [create, invite, remove, setAi];
  }

  it("round-trips every op type through encode/decode byte-for-byte", () => {
    for (const op of opOfEachType()) {
      const decoded = decodeOp(encodeOp(op));
      expect(decoded).toEqual(op);
      // encode is stable
      expect(Buffer.from(encodeOp(decoded)).equals(Buffer.from(encodeOp(op)))).toBe(true);
    }
  });

  // C7: an absent field and an empty string must NOT collide under length-prefixing.
  it("distinguishes an absent (null) subject from an empty-string subject (C7)", () => {
    const create = genesis({ founder, conversationId: cid, author: "F", initialMembers: [], aiMode: false });
    const withNullSubject = signWith(founder, {
      type: "setAiMode", conversationId: cid, seq: 1, prevHash: hashOp(create), author: "F",
      subject: null, aiMode: false, initialMembers: null, authorIdentityKey: pub(founder),
    });
    // Same op but subject is the empty string instead of null — a different preimage.
    const withEmptySubject: MembershipOp = { ...withNullSubject, subject: "" };

    const encNull = encodeForHashing(withNullSubject);
    const encEmpty = encodeForHashing(withEmptySubject);
    expect(encNull.equals(encEmpty)).toBe(false);
    expect(toHex(hashOp(withNullSubject))).not.toEqual(toHex(hashOp(withEmptySubject)));
  });

  it("distinguishes an absent initialMembers from an empty array", () => {
    const create = genesis({ founder, conversationId: cid, author: "F", initialMembers: [], aiMode: false });
    const emptyArray = encodeForHashing(create);
    const nullArray = encodeForHashing({ ...create, initialMembers: null });
    expect(emptyArray.equals(nullArray)).toBe(false);
  });

  it("rejects a buffer with trailing bytes (does not round-trip)", () => {
    const [create] = opOfEachType();
    const withTrailer = Buffer.concat([Buffer.from(encodeOp(create!)), Buffer.from([0x00])]);
    expect(() => decodeOp(withTrailer)).toThrow(CanonicalError);
  });

  it("rejects a buffer whose first tag is wrong for the field", () => {
    const [create] = opOfEachType();
    const bytes = Buffer.from(encodeOp(create!));
    bytes.writeUInt8(0x02, 0); // first field (type) must be a string tag 0x01, not uint 0x02
    expect(() => decodeOp(bytes)).toThrow(CanonicalError);
  });
});
