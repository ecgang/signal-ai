import { describe, expect, it } from "vitest";
import { parseEnvelope } from "../src/index.js";

describe("parseEnvelope", () => {
  it("parses a valid envelope", () => {
    const envelope = parseEnvelope({
      threadId: "thread-1",
      senderId: "user-1",
      ciphertext: new Uint8Array([1, 2, 3]),
      timestamp: Date.now(),
    });

    expect(envelope.threadId).toBe("thread-1");
    expect(envelope.ciphertext).toBeInstanceOf(Uint8Array);
  });

  it("rejects an invalid envelope", () => {
    expect(() => parseEnvelope({ threadId: "" })).toThrow();
  });
});
