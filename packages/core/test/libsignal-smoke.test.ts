import { describe, expect, it } from "vitest";
import { Identity } from "../src/index.js";

/**
 * Smoke test: if @signalapp/libsignal-client's native addon fails to load
 * on this platform/arch, `Identity.generate()` throws before any assertion
 * below runs. A green run here proves the native module loads on this host.
 */
describe("libsignal-client native module smoke test", () => {
  it("generates an identity key pair with the expected Curve25519 shape", () => {
    const identity = Identity.generate();
    const publicKeyBytes = identity.keyPair.publicKey.serialize();
    const privateKeyBytes = identity.keyPair.privateKey.serialize();

    // Curve25519 public key: 1-byte type prefix (0x05) + 32-byte key.
    expect(publicKeyBytes).toBeInstanceOf(Uint8Array);
    expect(publicKeyBytes).toHaveLength(33);
    expect(publicKeyBytes[0]).toBe(0x05);

    // Curve25519 private key: 32 raw bytes, no type prefix.
    expect(privateKeyBytes).toBeInstanceOf(Uint8Array);
    expect(privateKeyBytes).toHaveLength(32);

    expect(Number.isInteger(identity.registrationId)).toBe(true);
    expect(identity.registrationId).toBeGreaterThanOrEqual(1);
    expect(identity.registrationId).toBeLessThanOrEqual(16380);
  });

  it("generates distinct key pairs on each call", () => {
    const first = Identity.generate();
    const second = Identity.generate();
    expect(first.keyPair.publicKey.serialize()).not.toEqual(second.keyPair.publicKey.serialize());
    expect(first.keyPair.privateKey.serialize()).not.toEqual(second.keyPair.privateKey.serialize());
  });

  it("round-trips an identity through serialize/fromSerialized", () => {
    const original = Identity.generate();
    const serialized = original.serialize();
    const restored = Identity.fromSerialized(serialized.identityKeyPair, serialized.registrationId);

    expect(restored.keyPair.publicKey.serialize()).toEqual(original.keyPair.publicKey.serialize());
    expect(restored.registrationId).toBe(original.registrationId);
  });
});
