import { createHash } from "node:crypto";
import { PublicKey, type PrivateKey } from "@signalapp/libsignal-client";
import type { MembershipOp, UnsignedOp } from "./ops.js";
import { encodeForHashing, encodeForSigning } from "./canonical.js";

/**
 * Cryptographic primitives for the op-log. INVENT NO CRYPTO: signatures are
 * libsignal identity-key signatures (the primitive `@signalai/core` exposes via
 * `Identity.keyPair`) and the hash is SHA-256 from Node's `crypto`.
 *
 * Domain separation (design §7): the signing preimage is prefixed with
 * `"signal-ai/membership-op/v1"` and the hashing preimage with
 * `"signal-ai/membership-hash/v1"`, so a membership-op signature can never be
 * replayed as some other libsignal-signed artifact (or vice-versa).
 */
const SIGN_DOMAIN = new TextEncoder().encode("signal-ai/membership-op/v1");
const HASH_DOMAIN = new TextEncoder().encode("signal-ai/membership-hash/v1");

function signingPreimage(op: UnsignedOp): Buffer {
  return Buffer.concat([Buffer.from(SIGN_DOMAIN), encodeForSigning(op)]);
}

/** Signs an unsigned op with the author's identity private key (design §7). */
export function signOp(op: UnsignedOp, privateKey: PrivateKey): Uint8Array {
  return privateKey.sign(signingPreimage(op));
}

/**
 * Verifies an op's signature against the `authorIdentityKey` carried IN the op.
 * Key-pinning (that this key is the genesis authority key) is enforced
 * separately in `verifyChain` — this only checks the signature itself is valid
 * for the embedded key. Returns `false` (never throws) on any malformed input.
 */
export function verifyOpSig(op: MembershipOp): boolean {
  try {
    const pub = PublicKey.deserialize(Buffer.from(op.authorIdentityKey));
    // `signingPreimage` reads only the unsigned fields; the extra `sig` on a
    // MembershipOp is ignored, so the preimage matches what `signOp` signed.
    return pub.verify(signingPreimage(op), Buffer.from(op.sig));
  } catch {
    return false;
  }
}

/** `H(canonical(op))` — SHA-256 over the domain-separated full-op encoding (design §7). */
export function hashOp(op: MembershipOp): Uint8Array {
  return new Uint8Array(createHash("sha256").update(Buffer.concat([Buffer.from(HASH_DOMAIN), encodeForHashing(op)])).digest());
}

/** Lowercase-hex of a byte string (the wire form of `headHash`). */
export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** Constant-length byte equality. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
