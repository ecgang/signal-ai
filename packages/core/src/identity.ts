import { randomInt } from "node:crypto";
import { IdentityKeyPair } from "@signalapp/libsignal-client";

/**
 * Registration IDs are a locally-chosen value in [1, 16380] per the Signal
 * protocol spec (14 bits, zero excluded). libsignal-client's protocol stores
 * consume a registration id but the library has no generator for one, so a
 * spec-compliant random id is derived here via node:crypto (this is an id,
 * not secret key material).
 */
const MIN_REGISTRATION_ID = 1;
const MAX_REGISTRATION_ID = 16380;

/** Generates a spec-compliant Signal protocol registration id. */
export function generateRegistrationId(): number {
  return randomInt(MIN_REGISTRATION_ID, MAX_REGISTRATION_ID + 1);
}

/**
 * A local party's Signal-protocol identity: the long-term IdentityKeyPair
 * every session and prekey handshake ties back to, plus the registration id
 * published alongside it. This is the foundational identity every thread
 * member — human or AI agent — holds.
 */
export class Identity {
  private constructor(
    readonly keyPair: IdentityKeyPair,
    readonly registrationId: number,
  ) {}

  /** Generates a fresh identity: a new libsignal IdentityKeyPair plus a new registration id. */
  static generate(): Identity {
    return new Identity(IdentityKeyPair.generate(), generateRegistrationId());
  }

  /** Reconstructs a previously-generated identity from its serialized key pair and registration id. */
  static fromSerialized(identityKeyPair: Uint8Array, registrationId: number): Identity {
    return new Identity(IdentityKeyPair.deserialize(identityKeyPair), registrationId);
  }

  /** Serializes this identity's key material for persistence. */
  serialize(): { identityKeyPair: Uint8Array; registrationId: number } {
    return { identityKeyPair: this.keyPair.serialize(), registrationId: this.registrationId };
  }
}
