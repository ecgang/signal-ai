import { PreKeyBundle, PublicKey, KEMPublicKey } from "@signalapp/libsignal-client";
import type { PreKeyBundlePublic } from "@signalai/proto";

/** Base64-encodes raw key/record bytes for the JSON-friendly wire format @signalai/proto defines. */
export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** Decodes a base64 string produced by {@link toBase64} back into raw bytes. */
export function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

/**
 * Converts a libsignal `PreKeyBundle` into the wire shape defined by
 * `@signalai/proto`'s `PreKeyBundlePublicSchema`, so it can be published to
 * (or fetched from) the relay as JSON. `userId` is supplied separately
 * because a PreKeyBundle only describes one device's key material, not who
 * owns it.
 */
export function bundleToWire(bundle: PreKeyBundle, userId: string): PreKeyBundlePublic {
  const preKeyId = bundle.preKeyId();
  const preKeyPublic = bundle.preKeyPublic();

  return {
    userId,
    deviceId: bundle.deviceId(),
    registrationId: bundle.registrationId(),
    identityKey: toBase64(bundle.identityKey().serialize()),
    signedPreKeyId: bundle.signedPreKeyId(),
    signedPreKeyPublic: toBase64(bundle.signedPreKeyPublic().serialize()),
    signedPreKeySignature: toBase64(bundle.signedPreKeySignature()),
    ...(preKeyId !== null && preKeyPublic !== null
      ? { preKeyId, preKeyPublic: toBase64(preKeyPublic.serialize()) }
      : {}),
    kyberPreKeyId: bundle.kyberPreKeyId(),
    kyberPreKeyPublic: toBase64(bundle.kyberPreKeyPublic().serialize()),
    kyberPreKeySignature: toBase64(bundle.kyberPreKeySignature()),
  };
}

/** Reconstructs a libsignal `PreKeyBundle` from its wire shape (the inverse of {@link bundleToWire}). */
export function bundleFromWire(wire: PreKeyBundlePublic): PreKeyBundle {
  return PreKeyBundle.new(
    wire.registrationId,
    wire.deviceId,
    wire.preKeyId ?? null,
    wire.preKeyPublic ? PublicKey.deserialize(fromBase64(wire.preKeyPublic)) : null,
    wire.signedPreKeyId,
    PublicKey.deserialize(fromBase64(wire.signedPreKeyPublic)),
    fromBase64(wire.signedPreKeySignature),
    PublicKey.deserialize(fromBase64(wire.identityKey)),
    wire.kyberPreKeyId,
    KEMPublicKey.deserialize(fromBase64(wire.kyberPreKeyPublic)),
    fromBase64(wire.kyberPreKeySignature),
  );
}
