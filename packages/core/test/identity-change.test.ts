import { describe, expect, it } from "vitest";
import { IdentityChange } from "@signalapp/libsignal-client";
import { createParty, textToBytes, bytesToText } from "./helpers.js";

describe("identity key change detection", () => {
  it("surfaces a peer's identity key rotation through CoreStores' IdentityKeyStore via IdentityChange", async () => {
    const alice = await createParty("alice-idchange");
    const bobV1 = await createParty("bob-idchange");

    await alice.sessionManager.establishSession(bobV1.address, bobV1.nextBundle());
    const ct1 = await alice.sessionManager.encrypt(bobV1.address, textToBytes("hi"));
    expect(bytesToText(await bobV1.sessionManager.decrypt(alice.address, ct1.type(), ct1.serialize()))).toBe("hi");

    const bobAddressKey = "bob-idchange.1";
    const changesBefore = alice.stores.identity.changeLog.filter((c) => c.address === bobAddressKey);
    expect(changesBefore.length).toBeGreaterThan(0);
    expect(changesBefore.every((c) => c.change === IdentityChange.NewOrUnchanged)).toBe(true);

    // "Bob" reinstalls: a brand-new identity key pair + stores + bundle
    // under the same (userId, deviceId) address.
    const bobV2 = await createParty("bob-idchange", bobV1.address.deviceId);
    await alice.sessionManager.establishSession(bobV2.address, bobV2.nextBundle());

    const changesAfter = alice.stores.identity.changeLog.filter((c) => c.address === bobAddressKey);
    expect(changesAfter.some((c) => c.change === IdentityChange.ReplacedExisting)).toBe(true);

    // The new session with bobV2 still works correctly — isTrustedIdentity
    // trusts the rotated key rather than silently blocking the send;
    // the change is surfaced via changeLog for the caller to react to.
    const ct2 = await alice.sessionManager.encrypt(bobV2.address, textToBytes("hi again"));
    expect(bytesToText(await bobV2.sessionManager.decrypt(alice.address, ct2.type(), ct2.serialize()))).toBe(
      "hi again",
    );
  });
});
