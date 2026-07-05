import { describe, expect, it } from "vitest";
import { InMemoryStores, SessionManager } from "../src/index.js";
import { createParty, textToBytes, bytesToText } from "./helpers.js";

describe("store serialization round-trip", () => {
  it("preserves session and prekey state across toBytes/fromBytes so decryption and further ratcheting still work", async () => {
    const alice = await createParty("alice-serialize");
    const bob = await createParty("bob-serialize");

    await alice.sessionManager.establishSession(bob.address, bob.nextBundle());
    const ct1 = await alice.sessionManager.encrypt(bob.address, textToBytes("before serialize"));
    expect(bytesToText(await bob.sessionManager.decrypt(alice.address, ct1.type(), ct1.serialize()))).toBe(
      "before serialize",
    );

    // Serialize both parties' stores to bytes and rebuild fresh store
    // objects from them — simulating a process restart / reload from disk.
    const aliceBytes = alice.stores.toBytes();
    const bobBytes = bob.stores.toBytes();
    expect(aliceBytes).toBeInstanceOf(Uint8Array);
    expect(bobBytes).toBeInstanceOf(Uint8Array);

    const rebuiltAliceStores = InMemoryStores.fromBytes(aliceBytes);
    const rebuiltBobStores = InMemoryStores.fromBytes(bobBytes);

    const rebuiltAliceSession = new SessionManager(alice.address, rebuiltAliceStores);
    const rebuiltBobSession = new SessionManager(bob.address, rebuiltBobStores);

    // Further ratcheting on the rebuilt stores still works, in both directions.
    const ct2 = await rebuiltAliceSession.encrypt(bob.address, textToBytes("after serialize"));
    expect(bytesToText(await rebuiltBobSession.decrypt(alice.address, ct2.type(), ct2.serialize()))).toBe(
      "after serialize",
    );

    const reply = await rebuiltBobSession.encrypt(alice.address, textToBytes("reply after serialize"));
    expect(bytesToText(await rebuiltAliceSession.decrypt(bob.address, reply.type(), reply.serialize()))).toBe(
      "reply after serialize",
    );
  });
});
