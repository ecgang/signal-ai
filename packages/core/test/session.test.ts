import { describe, expect, it } from "vitest";
import { createParty, textToBytes, bytesToText } from "./helpers.js";

describe("two-party session", () => {
  it("establishes a session from a bundle and exchanges messages bidirectionally", async () => {
    const alice = await createParty("alice-2p");
    const bob = await createParty("bob-2p");

    await alice.sessionManager.establishSession(bob.address, bob.nextBundle());

    const aliceToBob1 = await alice.sessionManager.encrypt(bob.address, textToBytes("hi bob"));
    const plaintext1 = await bob.sessionManager.decrypt(alice.address, aliceToBob1.type(), aliceToBob1.serialize());
    expect(bytesToText(plaintext1)).toBe("hi bob");

    // Bob never called establishSession explicitly — his side of the
    // session was created lazily by the decrypt above (signalDecryptPreKey).
    const bobToAlice1 = await bob.sessionManager.encrypt(alice.address, textToBytes("hi alice"));
    const plaintext2 = await alice.sessionManager.decrypt(bob.address, bobToAlice1.type(), bobToAlice1.serialize());
    expect(bytesToText(plaintext2)).toBe("hi alice");

    // The ratchet keeps advancing correctly in both directions.
    const aliceToBob2 = await alice.sessionManager.encrypt(bob.address, textToBytes("second message"));
    const plaintext3 = await bob.sessionManager.decrypt(alice.address, aliceToBob2.type(), aliceToBob2.serialize());
    expect(bytesToText(plaintext3)).toBe("second message");

    const bobToAlice2 = await bob.sessionManager.encrypt(alice.address, textToBytes("second reply"));
    const plaintext4 = await alice.sessionManager.decrypt(bob.address, bobToAlice2.type(), bobToAlice2.serialize());
    expect(bytesToText(plaintext4)).toBe("second reply");
  });
});

describe("out-of-order delivery", () => {
  it("decrypts messages correctly even when delivered out of order", async () => {
    const alice = await createParty("alice-ooo");
    const bob = await createParty("bob-ooo");
    await alice.sessionManager.establishSession(bob.address, bob.nextBundle());

    // Establish + acknowledge first so the messages under test are plain
    // Whisper (ratchet) messages — the case skipped-message-key handling
    // for out-of-order delivery is actually exercising.
    const first = await alice.sessionManager.encrypt(bob.address, textToBytes("hello"));
    await bob.sessionManager.decrypt(alice.address, first.type(), first.serialize());
    const reply = await bob.sessionManager.encrypt(alice.address, textToBytes("hi"));
    await alice.sessionManager.decrypt(bob.address, reply.type(), reply.serialize());

    const messages = ["one", "two", "three", "four"];
    const ciphertexts: Array<{ type: number; bytes: Uint8Array }> = [];
    for (const message of messages) {
      const ct = await alice.sessionManager.encrypt(bob.address, textToBytes(message));
      ciphertexts.push({ type: ct.type(), bytes: ct.serialize() });
    }

    const deliveryOrder = [2, 0, 3, 1];
    for (const i of deliveryOrder) {
      const entry = ciphertexts[i];
      const plaintext = await bob.sessionManager.decrypt(alice.address, entry.type, entry.bytes);
      expect(bytesToText(plaintext)).toBe(messages[i]);
    }
  });
});
