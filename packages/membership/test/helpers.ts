import { Identity } from "@signalai/core";
import {
  GENESIS_ZERO,
  hashOp,
  headOf,
  signOp,
  type Head,
  type MembershipOp,
  type UnsignedOp,
} from "../src/index.js";

/** A fresh libsignal identity for a test peer. */
export function makeIdentity(): Identity {
  return Identity.generate();
}

/** The serialized identity public key bytes for an identity. */
export function pub(id: Identity): Uint8Array {
  return id.keyPair.publicKey.serialize();
}

/** Signs an unsigned op with an identity's private key (low-level op forging for tests). */
export function signWith(id: Identity, unsigned: UnsignedOp): MembershipOp {
  return { ...unsigned, sig: signOp(unsigned, id.keyPair.privateKey) };
}

/** Builds a genesis `create` op signed by `founder`. */
export function genesis(opts: {
  founder: Identity;
  conversationId: string;
  author: string;
  initialMembers: string[];
  aiMode?: boolean;
}): MembershipOp {
  return signWith(opts.founder, {
    type: "create",
    conversationId: opts.conversationId,
    seq: 0,
    prevHash: GENESIS_ZERO,
    author: opts.author,
    subject: null,
    aiMode: opts.aiMode ?? false,
    initialMembers: [...opts.initialMembers],
    authorIdentityKey: pub(opts.founder),
  });
}

/** Appends an op onto `chain`, signed by `signer` (defaults to the founder key of genesis semantics). */
export function append(
  chain: MembershipOp[],
  signer: Identity,
  fields: {
    type: MembershipOp["type"];
    author: string;
    subject?: string | null;
    aiMode?: boolean | null;
    initialMembers?: string[] | null;
    authorIdentityKey?: Uint8Array;
    conversationId?: string;
  },
): MembershipOp {
  const prev = chain[chain.length - 1]!;
  return signWith(signer, {
    type: fields.type,
    conversationId: fields.conversationId ?? prev.conversationId,
    seq: prev.seq + 1,
    prevHash: hashOp(prev),
    author: fields.author,
    subject: fields.subject ?? null,
    aiMode: fields.aiMode ?? null,
    initialMembers: fields.initialMembers ?? null,
    authorIdentityKey: fields.authorIdentityKey ?? pub(signer),
  });
}

/** The head `(seq, headHash)` of a chain. */
export function head(chain: MembershipOp[]): Head {
  return headOf(chain);
}
