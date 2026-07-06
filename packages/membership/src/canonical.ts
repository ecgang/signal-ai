import type { MembershipOp, UnsignedOp } from "./ops.js";

/**
 * Canonical, deterministic byte encoding for membership ops (design §7).
 *
 * NOT `JSON.stringify`: JSON's key-order and unicode-escaping ambiguity is a
 * signature-forgery / duplication surface. Instead every field is encoded as
 * `(1-byte type tag ‖ uint32 big-endian length ‖ body)` in a FIXED field
 * order, so exactly one byte string represents any given op.
 *
 * Distinct type tags (closes Linus C7): `absent/null`, an empty string, and an
 * empty array must never collide under length-prefixing alone (a zero-length
 * string and an absent field would otherwise both encode to `len=0`). So each
 * concrete type carries its own tag:
 *   0x00 = absent/null, 0x01 = string, 0x02 = uint, 0x03 = bool,
 *   0x04 = userId-array, 0x05 = bytes (key/hash/sig).
 * An empty string is `0x01,len=0`; an absent `subject` is `0x00,len=0` —
 * different preimages, different hash.
 *
 * `decodeOp` is the exact inverse and REJECTS any buffer that does not
 * round-trip: it validates each field's tag against the field's declared type,
 * forbids trailing bytes, and re-encodes the decoded op to assert byte-equality
 * with the input.
 */

const TAG_ABSENT = 0x00;
const TAG_STRING = 0x01;
const TAG_UINT = 0x02;
const TAG_BOOL = 0x03;
const TAG_ARRAY = 0x04;
const TAG_BYTES = 0x05;

export class CanonicalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalError";
  }
}

class Writer {
  private readonly chunks: Buffer[] = [];

  private field(tag: number, body: Buffer): void {
    const header = Buffer.alloc(5);
    header.writeUInt8(tag, 0);
    header.writeUInt32BE(body.length, 1);
    this.chunks.push(header, body);
  }

  absent(): void {
    this.field(TAG_ABSENT, Buffer.alloc(0));
  }

  str(value: string): void {
    this.field(TAG_STRING, Buffer.from(value, "utf8"));
  }

  uint(value: number): void {
    if (!Number.isInteger(value) || value < 0) throw new CanonicalError(`uint must be a non-negative integer, got ${value}`);
    const body = Buffer.alloc(8);
    body.writeBigUInt64BE(BigInt(value), 0);
    this.field(TAG_UINT, body);
  }

  bool(value: boolean): void {
    this.field(TAG_BOOL, Buffer.from([value ? 1 : 0]));
  }

  bytes(value: Uint8Array): void {
    this.field(TAG_BYTES, Buffer.from(value));
  }

  arr(items: string[]): void {
    const parts: Buffer[] = [];
    const count = Buffer.alloc(4);
    count.writeUInt32BE(items.length, 0);
    parts.push(count);
    for (const item of items) {
      const eb = Buffer.from(item, "utf8");
      const len = Buffer.alloc(4);
      len.writeUInt32BE(eb.length, 0);
      parts.push(len, eb);
    }
    this.field(TAG_ARRAY, Buffer.concat(parts));
  }

  concat(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

class Reader {
  private pos = 0;
  constructor(private readonly buf: Buffer) {}

  private header(expected: number): number {
    if (this.pos + 5 > this.buf.length) throw new CanonicalError("truncated field header");
    const tag = this.buf.readUInt8(this.pos);
    if (tag !== expected) throw new CanonicalError(`tag mismatch: expected 0x${expected.toString(16)}, got 0x${tag.toString(16)}`);
    const len = this.buf.readUInt32BE(this.pos + 1);
    this.pos += 5;
    if (this.pos + len > this.buf.length) throw new CanonicalError("field length exceeds buffer");
    return len;
  }

  /** Peeks the next tag without consuming it (for nullable fields). */
  private peekTag(): number {
    if (this.pos + 5 > this.buf.length) throw new CanonicalError("truncated field header");
    return this.buf.readUInt8(this.pos);
  }

  str(): string {
    const len = this.header(TAG_STRING);
    const s = this.buf.toString("utf8", this.pos, this.pos + len);
    this.pos += len;
    return s;
  }

  uint(): number {
    const len = this.header(TAG_UINT);
    if (len !== 8) throw new CanonicalError(`uint length must be 8, got ${len}`);
    const v = this.buf.readBigUInt64BE(this.pos);
    this.pos += len;
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new CanonicalError("uint exceeds MAX_SAFE_INTEGER");
    return Number(v);
  }

  bytes(): Uint8Array {
    const len = this.header(TAG_BYTES);
    const out = new Uint8Array(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return out;
  }

  nullableStr(): string | null {
    if (this.peekTag() === TAG_ABSENT) {
      this.header(TAG_ABSENT);
      return null;
    }
    return this.str();
  }

  nullableBool(): boolean | null {
    if (this.peekTag() === TAG_ABSENT) {
      this.header(TAG_ABSENT);
      return null;
    }
    const len = this.header(TAG_BOOL);
    if (len !== 1) throw new CanonicalError(`bool length must be 1, got ${len}`);
    const b = this.buf.readUInt8(this.pos);
    this.pos += 1;
    if (b !== 0 && b !== 1) throw new CanonicalError(`bool body must be 0 or 1, got ${b}`);
    return b === 1;
  }

  nullableArr(): string[] | null {
    if (this.peekTag() === TAG_ABSENT) {
      this.header(TAG_ABSENT);
      return null;
    }
    const len = this.header(TAG_ARRAY);
    const end = this.pos + len;
    if (this.pos + 4 > end) throw new CanonicalError("array missing count");
    const count = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    const items: string[] = [];
    for (let i = 0; i < count; i++) {
      if (this.pos + 4 > end) throw new CanonicalError("array element length past field");
      const elen = this.buf.readUInt32BE(this.pos);
      this.pos += 4;
      if (this.pos + elen > end) throw new CanonicalError("array element body past field");
      items.push(this.buf.toString("utf8", this.pos, this.pos + elen));
      this.pos += elen;
    }
    if (this.pos !== end) throw new CanonicalError("array body has trailing bytes");
    return items;
  }

  atEnd(): boolean {
    return this.pos === this.buf.length;
  }
}

/**
 * Encodes an op's fields in canonical order. When `includeSig` is false the
 * result is the signing preimage (design §2: sig = libsignal sig over
 * `canonical(all fields except sig)`); when true it is the hashing preimage
 * (design §7: headHash / prevHash = `H(canonical(op))` over ALL fields).
 */
function encodeFields(op: UnsignedOp & { sig?: Uint8Array }, includeSig: boolean): Buffer {
  const w = new Writer();
  w.str(op.type);
  w.str(op.conversationId);
  w.uint(op.seq);
  w.bytes(op.prevHash);
  w.str(op.author);
  if (op.subject === null) w.absent();
  else w.str(op.subject);
  if (op.aiMode === null) w.absent();
  else w.bool(op.aiMode);
  if (op.initialMembers === null) w.absent();
  else w.arr(op.initialMembers);
  w.bytes(op.authorIdentityKey);
  if (includeSig) {
    if (op.sig === undefined) throw new CanonicalError("cannot hash-encode an op without a signature");
    w.bytes(op.sig);
  }
  return w.concat();
}

/** The signing preimage: canonical encoding of all fields EXCEPT `sig`. */
export function encodeForSigning(op: UnsignedOp): Buffer {
  return encodeFields(op, false);
}

/** The hashing / wire preimage: canonical encoding of ALL fields INCLUDING `sig`. */
export function encodeForHashing(op: MembershipOp): Buffer {
  return encodeFields(op, true);
}

/** The on-wire byte form of an op (identical to the hashing preimage). */
export function encodeOp(op: MembershipOp): Uint8Array {
  return new Uint8Array(encodeForHashing(op));
}

/**
 * Decodes an on-wire op. The exact inverse of {@link encodeOp}: it validates
 * every field's tag, forbids trailing bytes, and re-encodes to assert byte
 * equality with the input — any buffer that does not round-trip is rejected.
 */
export function decodeOp(bytes: Uint8Array): MembershipOp {
  const buf = Buffer.from(bytes);
  const r = new Reader(buf);
  const op: MembershipOp = {
    type: r.str() as MembershipOp["type"],
    conversationId: r.str(),
    seq: r.uint(),
    prevHash: r.bytes(),
    author: r.str(),
    subject: r.nullableStr(),
    aiMode: r.nullableBool(),
    initialMembers: r.nullableArr(),
    authorIdentityKey: r.bytes(),
    sig: r.bytes(),
  };
  if (!r.atEnd()) throw new CanonicalError("trailing bytes after op");
  if (op.type !== "create" && op.type !== "invite" && op.type !== "remove" && op.type !== "setAiMode") {
    throw new CanonicalError(`unknown op type "${op.type}"`);
  }
  const reencoded = encodeForHashing(op);
  if (!reencoded.equals(buf)) throw new CanonicalError("op does not round-trip canonically");
  return op;
}
