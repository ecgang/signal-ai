import {
  type CoreStores,
  type Identity,
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
}
