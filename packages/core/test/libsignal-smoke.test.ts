import { describe, expect, it } from "vitest";
import { generateIdentity, generateRegistrationId } from "../src/index.js";

/**
 * Smoke test: if @signalapp/libsignal-client's native addon fails to load
 * on this platform/arch, `generateIdentity()` throws before any assertion
 * below runs. A green run here proves the native module loads on this host.
 */
describe("libsignal-client native module smoke test", () => {
  it("generates an identity key pair with the expected Curve25519 shape", () => {
    const identity = generateIdentity();

    // Curve25519 public key: 1-byte type prefix (0x05) + 32-byte key.
    expect(identity.publicKey).toBeInstanceOf(Uint8Array);
    expect(identity.publicKey).toHaveLength(33);
    expect(identity.publicKey[0]).toBe(0x05);

    // Curve25519 private key: 32 raw bytes, no type prefix.
    expect(identity.privateKey).toBeInstanceOf(Uint8Array);
    expect(identity.privateKey).toHaveLength(32);

    expect(Number.isInteger(identity.registrationId)).toBe(true);
    expect(identity.registrationId).toBeGreaterThanOrEqual(1);
    expect(identity.registrationId).toBeLessThanOrEqual(16380);
  });

  it("generates distinct key pairs on each call", () => {
    const first = generateIdentity();
    const second = generateIdentity();
    expect(first.publicKey).not.toEqual(second.publicKey);
    expect(first.privateKey).not.toEqual(second.privateKey);
  });

  it("generates a registration id within the protocol's valid range", () => {
    const id = generateRegistrationId();
    expect(id).toBeGreaterThanOrEqual(1);
    expect(id).toBeLessThanOrEqual(16380);
  });
});
