import { describe, expect, it } from "vitest";
import { IntegrityError, parseInvitePin, serializeInvitePin, type InvitePin } from "../src/index.js";

/**
 * The out-of-band {@link InvitePin} serialization boundary (design §4). A pin
 * crosses an untrusted transcription channel (invite link / QR / manual paste),
 * so the parser must round-trip valid pins byte-for-byte AND reject anything
 * malformed rather than silently seed a garbage pin (which would collapse the
 * TOFU guarantee back to blind relay trust without anyone noticing).
 */
describe("InvitePin serialize/parse", () => {
  const good: InvitePin = {
    conversationId: "conv-123",
    genesisHash: "a1b2c3",
    pinnedHead: { seq: 2, headHash: "deadbeef" },
  };

  it("round-trips a valid pin", () => {
    expect(parseInvitePin(serializeInvitePin(good))).toEqual(good);
  });

  it("rejects non-JSON", () => {
    expect(() => parseInvitePin("not json")).toThrow(IntegrityError);
  });

  it("rejects a non-object payload", () => {
    expect(() => parseInvitePin("42")).toThrow(IntegrityError);
    expect(() => parseInvitePin("null")).toThrow(IntegrityError);
  });

  it("rejects a missing/empty conversationId", () => {
    expect(() => parseInvitePin(JSON.stringify({ ...good, conversationId: "" }))).toThrow(IntegrityError);
    expect(() => parseInvitePin(JSON.stringify({ genesisHash: good.genesisHash, pinnedHead: good.pinnedHead }))).toThrow(
      IntegrityError,
    );
  });

  it("rejects a non-hex genesisHash", () => {
    expect(() => parseInvitePin(JSON.stringify({ ...good, genesisHash: "XYZ" }))).toThrow(IntegrityError);
    expect(() => parseInvitePin(JSON.stringify({ ...good, genesisHash: 123 }))).toThrow(IntegrityError);
  });

  it("rejects a malformed pinnedHead", () => {
    expect(() => parseInvitePin(JSON.stringify({ ...good, pinnedHead: null }))).toThrow(IntegrityError);
    expect(() => parseInvitePin(JSON.stringify({ ...good, pinnedHead: { seq: -1, headHash: "ab" } }))).toThrow(
      IntegrityError,
    );
    expect(() => parseInvitePin(JSON.stringify({ ...good, pinnedHead: { seq: 1.5, headHash: "ab" } }))).toThrow(
      IntegrityError,
    );
    expect(() => parseInvitePin(JSON.stringify({ ...good, pinnedHead: { seq: 0, headHash: "nothex" } }))).toThrow(
      IntegrityError,
    );
  });
});
