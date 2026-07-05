import {
  IdentityKeyStore,
  SessionStore,
  PreKeyStore,
  SignedPreKeyStore,
  KyberPreKeyStore,
  PrivateKey,
  PublicKey,
  ProtocolAddress,
  SessionRecord,
  PreKeyRecord,
  SignedPreKeyRecord,
  KyberPreKeyRecord,
  IdentityChange,
  Direction,
} from "@signalapp/libsignal-client";
import { toBase64, fromBase64 } from "./wire.js";

function addressKey(address: ProtocolAddress): string {
  return `${address.name()}.${address.deviceId()}`;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** One observed identity-key change for a remote address, as reported by `saveIdentity()`. */
export interface IdentityChangeRecord {
  address: string;
  change: IdentityChange;
  observedAt: number;
}

/** JSON-safe serialized form of an {@link InMemoryIdentityKeyStore}. */
export interface SerializedIdentityStore {
  privateKey: string;
  registrationId: number;
  remoteIdentities: Array<{ address: string; key: string }>;
}

/**
 * In-memory `IdentityKeyStore` for a single local identity.
 *
 * Identities are trusted on first use and remain trusted after a key
 * rotation (`isTrustedIdentity` always resolves `true`) — libsignal's
 * `IdentityChange` enum already tells the caller when a peer's identity key
 * changed via `saveIdentity`'s return value, so this store surfaces that
 * signal through `changeLog` instead of silently blocking sends on it.
 */
export class InMemoryIdentityKeyStore extends IdentityKeyStore {
  private readonly remoteIdentities = new Map<string, Uint8Array>();

  /** Every identity-key change observed via `saveIdentity`, in order. */
  readonly changeLog: IdentityChangeRecord[] = [];

  constructor(
    private readonly privateKey: PrivateKey,
    private readonly registrationId: number,
  ) {
    super();
  }

  async getIdentityKey(): Promise<PrivateKey> {
    return this.privateKey;
  }

  async getLocalRegistrationId(): Promise<number> {
    return this.registrationId;
  }

  async saveIdentity(name: ProtocolAddress, key: PublicKey): Promise<IdentityChange> {
    const addrKey = addressKey(name);
    const existing = this.remoteIdentities.get(addrKey);
    const serialized = key.serialize();
    const change =
      existing && !bytesEqual(existing, serialized) ? IdentityChange.ReplacedExisting : IdentityChange.NewOrUnchanged;

    this.remoteIdentities.set(addrKey, serialized);
    this.changeLog.push({ address: addrKey, change, observedAt: Date.now() });
    return change;
  }

  async isTrustedIdentity(_name: ProtocolAddress, _key: PublicKey, _direction: Direction): Promise<boolean> {
    return true;
  }

  async getIdentity(name: ProtocolAddress): Promise<PublicKey | null> {
    const existing = this.remoteIdentities.get(addressKey(name));
    return existing ? PublicKey.deserialize(existing) : null;
  }

  /** Serializes this store's local private key and every known remote identity to JSON-safe data. */
  toJSON(): SerializedIdentityStore {
    return {
      privateKey: toBase64(this.privateKey.serialize()),
      registrationId: this.registrationId,
      remoteIdentities: [...this.remoteIdentities.entries()].map(([address, key]) => ({
        address,
        key: toBase64(key),
      })),
    };
  }

  /** Rebuilds a store from data produced by {@link toJSON}. The `changeLog` is not carried across serialization. */
  static fromJSON(data: SerializedIdentityStore): InMemoryIdentityKeyStore {
    const store = new InMemoryIdentityKeyStore(PrivateKey.deserialize(fromBase64(data.privateKey)), data.registrationId);
    for (const entry of data.remoteIdentities) {
      store.remoteIdentities.set(entry.address, fromBase64(entry.key));
    }
    return store;
  }
}

/** JSON-safe serialized form of an {@link InMemorySessionStore}. */
export type SerializedSessionStore = Array<{ address: string; record: string }>;

/** In-memory `SessionStore` keyed by `"<name>.<deviceId>"`. */
export class InMemorySessionStore extends SessionStore {
  private readonly sessions = new Map<string, Uint8Array>();

  async saveSession(name: ProtocolAddress, record: SessionRecord): Promise<void> {
    this.sessions.set(addressKey(name), record.serialize());
  }

  async getSession(name: ProtocolAddress): Promise<SessionRecord | null> {
    const raw = this.sessions.get(addressKey(name));
    return raw ? SessionRecord.deserialize(raw) : null;
  }

  async getExistingSessions(addresses: ProtocolAddress[]): Promise<SessionRecord[]> {
    return addresses.map((address) => {
      const raw = this.sessions.get(addressKey(address));
      if (!raw) throw new Error(`no session for ${addressKey(address)}`);
      return SessionRecord.deserialize(raw);
    });
  }

  /** Serializes every stored session record to JSON-safe data. */
  toJSON(): SerializedSessionStore {
    return [...this.sessions.entries()].map(([address, record]) => ({ address, record: toBase64(record) }));
  }

  /** Rebuilds a store from data produced by {@link toJSON}. */
  static fromJSON(data: SerializedSessionStore): InMemorySessionStore {
    const store = new InMemorySessionStore();
    for (const entry of data) {
      store.sessions.set(entry.address, fromBase64(entry.record));
    }
    return store;
  }
}

/** JSON-safe serialized form of an id-keyed prekey store. */
export type SerializedIdKeyedStore = Array<{ id: number; record: string }>;

/** In-memory `PreKeyStore` for one-time EC prekeys. */
export class InMemoryPreKeyStore extends PreKeyStore {
  private readonly preKeys = new Map<number, Uint8Array>();

  async savePreKey(id: number, record: PreKeyRecord): Promise<void> {
    this.preKeys.set(id, record.serialize());
  }

  async getPreKey(id: number): Promise<PreKeyRecord> {
    const raw = this.preKeys.get(id);
    if (!raw) throw new Error(`no prekey with id ${id}`);
    return PreKeyRecord.deserialize(raw);
  }

  async removePreKey(id: number): Promise<void> {
    this.preKeys.delete(id);
  }

  /** Serializes every stored one-time prekey to JSON-safe data. */
  toJSON(): SerializedIdKeyedStore {
    return [...this.preKeys.entries()].map(([id, record]) => ({ id, record: toBase64(record) }));
  }

  /** Rebuilds a store from data produced by {@link toJSON}. */
  static fromJSON(data: SerializedIdKeyedStore): InMemoryPreKeyStore {
    const store = new InMemoryPreKeyStore();
    for (const entry of data) store.preKeys.set(entry.id, fromBase64(entry.record));
    return store;
  }
}

/** In-memory `SignedPreKeyStore` for the device's signed EC prekey(s). */
export class InMemorySignedPreKeyStore extends SignedPreKeyStore {
  private readonly signedPreKeys = new Map<number, Uint8Array>();

  async saveSignedPreKey(id: number, record: SignedPreKeyRecord): Promise<void> {
    this.signedPreKeys.set(id, record.serialize());
  }

  async getSignedPreKey(id: number): Promise<SignedPreKeyRecord> {
    const raw = this.signedPreKeys.get(id);
    if (!raw) throw new Error(`no signed prekey with id ${id}`);
    return SignedPreKeyRecord.deserialize(raw);
  }

  /** Serializes every stored signed prekey to JSON-safe data. */
  toJSON(): SerializedIdKeyedStore {
    return [...this.signedPreKeys.entries()].map(([id, record]) => ({ id, record: toBase64(record) }));
  }

  /** Rebuilds a store from data produced by {@link toJSON}. */
  static fromJSON(data: SerializedIdKeyedStore): InMemorySignedPreKeyStore {
    const store = new InMemorySignedPreKeyStore();
    for (const entry of data) store.signedPreKeys.set(entry.id, fromBase64(entry.record));
    return store;
  }
}

/** One recorded use of a kyber prekey, as reported by `markKyberPreKeyUsed()`. */
export interface KyberPreKeyUsage {
  kyberPreKeyId: number;
  signedPreKeyId: number;
}

/**
 * In-memory `KyberPreKeyStore` for the device's signed (PQXDH) kyber
 * prekey(s). Unlike one-time EC prekeys, a signed kyber prekey is reusable
 * across many incoming handshakes, so `markKyberPreKeyUsed` only logs usage
 * rather than consuming the key.
 */
export class InMemoryKyberPreKeyStore extends KyberPreKeyStore {
  private readonly kyberPreKeys = new Map<number, Uint8Array>();

  /** Every recorded kyber prekey usage, in order. */
  readonly usageLog: KyberPreKeyUsage[] = [];

  async saveKyberPreKey(kyberPreKeyId: number, record: KyberPreKeyRecord): Promise<void> {
    this.kyberPreKeys.set(kyberPreKeyId, record.serialize());
  }

  async getKyberPreKey(kyberPreKeyId: number): Promise<KyberPreKeyRecord> {
    const raw = this.kyberPreKeys.get(kyberPreKeyId);
    if (!raw) throw new Error(`no kyber prekey with id ${kyberPreKeyId}`);
    return KyberPreKeyRecord.deserialize(raw);
  }

  async markKyberPreKeyUsed(kyberPreKeyId: number, signedPreKeyId: number, _baseKey: PublicKey): Promise<void> {
    this.usageLog.push({ kyberPreKeyId, signedPreKeyId });
  }

  /** Serializes every stored kyber prekey to JSON-safe data. */
  toJSON(): SerializedIdKeyedStore {
    return [...this.kyberPreKeys.entries()].map(([id, record]) => ({ id, record: toBase64(record) }));
  }

  /** Rebuilds a store from data produced by {@link toJSON}. */
  static fromJSON(data: SerializedIdKeyedStore): InMemoryKyberPreKeyStore {
    const store = new InMemoryKyberPreKeyStore();
    for (const entry of data) store.kyberPreKeys.set(entry.id, fromBase64(entry.record));
    return store;
  }
}

/**
 * The full set of libsignal protocol stores one local identity needs.
 * This is the store contract the rest of `@signalai/core` (and later,
 * `@signalai/client-sdk`) programs against — an alternate implementation
 * (e.g. persisted to disk/SQLite) only needs to satisfy this interface to
 * be usable everywhere `InMemoryStores` is today.
 */
export interface CoreStores {
  readonly identity: IdentityKeyStore;
  readonly session: SessionStore;
  readonly preKey: PreKeyStore;
  readonly signedPreKey: SignedPreKeyStore;
  readonly kyberPreKey: KyberPreKeyStore;
}

/** JSON-safe serialized form of an {@link InMemoryStores}. */
export interface SerializedStores {
  identity: SerializedIdentityStore;
  sessions: SerializedSessionStore;
  preKeys: SerializedIdKeyedStore;
  signedPreKeys: SerializedIdKeyedStore;
  kyberPreKeys: SerializedIdKeyedStore;
}

/**
 * Reference in-memory implementation of {@link CoreStores} for a single
 * local identity, bundling all five libsignal protocol stores.
 */
export class InMemoryStores implements CoreStores {
  private constructor(
    readonly identity: InMemoryIdentityKeyStore,
    readonly session: InMemorySessionStore,
    readonly preKey: InMemoryPreKeyStore,
    readonly signedPreKey: InMemorySignedPreKeyStore,
    readonly kyberPreKey: InMemoryKyberPreKeyStore,
  ) {}

  /** Creates an empty store set for a local identity's private key and registration id. */
  static create(privateKey: PrivateKey, registrationId: number): InMemoryStores {
    return new InMemoryStores(
      new InMemoryIdentityKeyStore(privateKey, registrationId),
      new InMemorySessionStore(),
      new InMemoryPreKeyStore(),
      new InMemorySignedPreKeyStore(),
      new InMemoryKyberPreKeyStore(),
    );
  }

  /** Serializes every underlying store to JSON-safe data. */
  toJSON(): SerializedStores {
    return {
      identity: this.identity.toJSON(),
      sessions: this.session.toJSON(),
      preKeys: this.preKey.toJSON(),
      signedPreKeys: this.signedPreKey.toJSON(),
      kyberPreKeys: this.kyberPreKey.toJSON(),
    };
  }

  /** Rebuilds a full store set from data produced by {@link toJSON}. */
  static fromJSON(data: SerializedStores): InMemoryStores {
    return new InMemoryStores(
      InMemoryIdentityKeyStore.fromJSON(data.identity),
      InMemorySessionStore.fromJSON(data.sessions),
      InMemoryPreKeyStore.fromJSON(data.preKeys),
      InMemorySignedPreKeyStore.fromJSON(data.signedPreKeys),
      InMemoryKyberPreKeyStore.fromJSON(data.kyberPreKeys),
    );
  }

  /** Serializes every store's key material (identity, sessions, and all prekeys) into a single opaque byte buffer. */
  toBytes(): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(this.toJSON()));
  }

  /** Rebuilds a full store set — including all sessions and prekeys — from {@link toBytes} output. */
  static fromBytes(bytes: Uint8Array): InMemoryStores {
    const data = JSON.parse(new TextDecoder().decode(bytes)) as SerializedStores;
    return InMemoryStores.fromJSON(data);
  }
}
