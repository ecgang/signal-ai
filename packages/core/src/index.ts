/**
 * @signalai/core — a thin, audited wrapper around @signalapp/libsignal-client.
 *
 * No cryptography is implemented in this package: every operation that
 * touches key material calls directly into libsignal-client's free-function
 * protocol API (`processPreKeyBundle`, `signalEncrypt`, `signalDecrypt`,
 * `signalDecryptPreKey`). This package only adds storage plumbing (the five
 * protocol stores), id/address bookkeeping, prekey provisioning, and wire
 * (de)serialization on top of it.
 */
export * from "./identity.js";
export * from "./stores.js";
export * from "./prekeys.js";
export * from "./session.js";
export * from "./group.js";
export * from "./wire.js";
