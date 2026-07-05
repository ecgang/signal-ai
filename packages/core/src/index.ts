import { randomInt } from "node:crypto";
import { IdentityKeyPair } from "@signalapp/libsignal-client";

/**
 * Registration IDs are a locally-chosen value in [1, 16380] per the Signal
 * protocol spec (14 bits, zero excluded). libsignal-client's protocol stores
 * consume a registration id but the library has no generator for one, so a
 * spec-compliant random id is derived here.
 */
const MIN_REGISTRATION_ID = 1;
const MAX_REGISTRATION_ID = 16380;

export function generateRegistrationId(): number {
  return randomInt(MIN_REGISTRATION_ID, MAX_REGISTRATION_ID + 1);
}

export interface GeneratedIdentity {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  registrationId: number;
}

/**
 * Generates a fresh Signal-protocol identity key pair via libsignal-client
 * plus a locally-chosen registration id. This is the foundational identity
 * every thread member — human or AI agent — holds.
 */
export function generateIdentity(): GeneratedIdentity {
  const identity = IdentityKeyPair.generate();
  return {
    publicKey: identity.publicKey.serialize(),
    privateKey: identity.privateKey.serialize(),
    registrationId: generateRegistrationId(),
  };
}
