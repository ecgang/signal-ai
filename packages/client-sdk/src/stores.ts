import {
  type CoreStores,
  type Identity,
  type SerializedIdentityStore,
  type SerializedSessionStore,
  type SerializedIdKeyedStore,
  InMemoryIdentityKeyStore,
  InMemorySessionStore,
  InMemoryPreKeyStore,
  InMemorySignedPreKeyStore,
  InMemoryKyberPreKeyStore,
} from "@signalai/core";

/** One cached conversation member's client-local metadata (see {@link Member}), keyed by userId. */
export interface CachedMember {
  deviceIds: number[];
  joinedAt: number;
}

/**
 * Client-local view of a conversation: its member cache and (best-effort)
 * ai-mode. `adminUserId` is only known when *this* client created the
 * conversation (the relay's membership rows don't expose role beyond what
 * `canManageMembership` checks server-side) — members are reported as
 * `"admin"` only when they match this, `"member"` otherwise.
 */
export interface CachedConversation {
  members: Map<string, CachedMember>;
  aiMode: boolean;
  adminUserId?: string;
}

/** A resolved contact: the durable relay `userId` behind a human-readable `username`. */
export interface DirectoryEntry {
  username: string;
  deviceIds: number[];
}

/** JSON-safe serialized form of one {@link CachedConversation} (its member `Map` flattened to entries). */
export interface SerializedCachedConversation {
  members: Array<[string, CachedMember]>;
  aiMode: boolean;
  adminUserId?: string;
}

/**
 * JSON-safe snapshot of an entire {@link InMemoryClientStores}: the five
 * libsignal protocol stores (each via its own `toJSON`) plus the three
 * client-only collections flattened to arrays. Rehydrated by
 * {@link InMemoryClientStores.fromJSON}. This is the unit a durable (e.g.
 * SQLite) store persists so a client can `SignalAiClient.resume(...)` its
 * exact identity + ratchet state after a restart. The identity store's
 * `changeLog` is intentionally NOT carried across (matches core behavior).
 */
export interface SerializedClientStores {
  identity: SerializedIdentityStore;
  sessions: SerializedSessionStore;
  preKeys: SerializedIdKeyedStore;
  signedPreKeys: SerializedIdKeyedStore;
  kyberPreKeys: SerializedIdKeyedStore;
  seenMsgIds: string[];
  directory: Array<[string, DirectoryEntry]>;
  conversations: Array<[string, SerializedCachedConversation]>;
}

/**
 * The full state one `@signalai/client-sdk` client instance needs, layered on
 * top of the five libsignal protocol stores from `@signalai/core`
 * ({@link CoreStores}). `identity` is narrowed to the concrete
 * `InMemoryIdentityKeyStore` (rather than the abstract `IdentityKeyStore`
 * `CoreStores` types it as) because the SDK needs two capabilities the base
 * class doesn't expose: reading back a peer's currently-known identity key
 * (for `Member.identityKeyFingerprint`) and observing `changeLog` (for the
 * `identityKeyChanged` system event).
 *
 * `seenMsgIds`, `conversations`, and `directory` are client-sdk-only state —
 * no equivalent exists in `@signalai/core`. A persisted (e.g. SQLite) impl of
 * this interface is deferred to a later phase; `InMemoryClientStores` is the
 * reference implementation used here and in tests.
 */
export interface ClientStores extends CoreStores {
  readonly identity: InMemoryIdentityKeyStore;
  /** msgIds of every plaintext message already delivered to the application, for de-dup on redelivery/resend. */
  readonly seenMsgIds: Set<string>;
  /** conversationId -> locally-cached membership + ai-mode state. */
  readonly conversations: Map<string, CachedConversation>;
  /** userId -> the username + device ids this client has resolved for that contact (see `resolveUser`). */
  readonly directory: Map<string, DirectoryEntry>;
}

export class InMemoryClientStores implements ClientStores {
  readonly seenMsgIds = new Set<string>();
  readonly conversations = new Map<string, CachedConversation>();
  readonly directory = new Map<string, DirectoryEntry>();

  private constructor(
    readonly identity: InMemoryIdentityKeyStore,
    readonly session: InMemorySessionStore,
    readonly preKey: InMemoryPreKeyStore,
    readonly signedPreKey: InMemorySignedPreKeyStore,
    readonly kyberPreKey: InMemoryKyberPreKeyStore,
  ) {}

  /** Creates an empty client store set for a local identity (see {@link Identity}). */
  static create(identity: Identity): InMemoryClientStores {
    return new InMemoryClientStores(
      new InMemoryIdentityKeyStore(identity.keyPair.privateKey, identity.registrationId),
      new InMemorySessionStore(),
      new InMemoryPreKeyStore(),
      new InMemorySignedPreKeyStore(),
      new InMemoryKyberPreKeyStore(),
    );
  }

  /** Flattens this store set (crypto stores + client-only collections) into a JSON-safe {@link SerializedClientStores}. */
  toJSON(): SerializedClientStores {
    return {
      identity: this.identity.toJSON(),
      sessions: this.session.toJSON(),
      preKeys: this.preKey.toJSON(),
      signedPreKeys: this.signedPreKey.toJSON(),
      kyberPreKeys: this.kyberPreKey.toJSON(),
      seenMsgIds: [...this.seenMsgIds],
      directory: [...this.directory.entries()],
      conversations: [...this.conversations.entries()].map(([id, conv]) => {
        const serialized: SerializedCachedConversation = {
          members: [...conv.members.entries()],
          aiMode: conv.aiMode,
        };
        if (conv.adminUserId !== undefined) serialized.adminUserId = conv.adminUserId;
        return [id, serialized];
      }),
    };
  }

  /** Rebuilds a full client store set from data produced by {@link toJSON}, reusing each crypto store's own `fromJSON`. */
  static fromJSON(data: SerializedClientStores): InMemoryClientStores {
    const stores = new InMemoryClientStores(
      InMemoryIdentityKeyStore.fromJSON(data.identity),
      InMemorySessionStore.fromJSON(data.sessions),
      InMemoryPreKeyStore.fromJSON(data.preKeys),
      InMemorySignedPreKeyStore.fromJSON(data.signedPreKeys),
      InMemoryKyberPreKeyStore.fromJSON(data.kyberPreKeys),
    );
    for (const id of data.seenMsgIds) stores.seenMsgIds.add(id);
    for (const [userId, entry] of data.directory) stores.directory.set(userId, entry);
    for (const [convId, conv] of data.conversations) {
      const rebuilt: CachedConversation = { members: new Map(conv.members), aiMode: conv.aiMode };
      if (conv.adminUserId !== undefined) rebuilt.adminUserId = conv.adminUserId;
      stores.conversations.set(convId, rebuilt);
    }
    return stores;
  }
}
