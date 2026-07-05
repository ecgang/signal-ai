import { randomUUID, createHash } from "node:crypto";
import {
  Identity,
  PrekeyManager,
  SessionManager,
  GroupFanout,
  toProtocolAddress,
  bundleToWire,
  bundleFromWire,
  fromBase64,
  type DeviceAddress,
  type ProvisionedPreKeys,
} from "@signalai/core";
import { parsePlaintextMessage, type PlaintextMessage, type Envelope, type PreKeyBundlePublic } from "@signalai/proto";
import { createHttpWsTransport, type Transport } from "./transport.js";
import { WsLink } from "./connection.js";
import { InMemoryClientStores, type ClientStores, type SerializedClientStores } from "./stores.js";
import type { ConnectionState, Member, SignalAiClientHandlers } from "./types.js";

const DEFAULT_INITIAL_OTP_COUNT = 5;
const DEFAULT_REPLENISH_BATCH = 5;

/**
 * Mirrors @signalapp/libsignal-client's `IdentityChange.ReplacedExisting`
 * (numeric value `1`, confirmed at the pinned 0.96.4 version @signalai/core
 * depends on). Hardcoded rather than imported so client-sdk doesn't need a
 * direct dependency on libsignal-client — the same avoid-the-native-dependency
 * pattern @signalai/proto uses for `CiphertextMessageType` (2|3).
 */
const IDENTITY_CHANGE_REPLACED_EXISTING = 1;

function fingerprintOf(key: { serialize(): Uint8Array } | null): string {
  if (!key) return "";
  return createHash("sha256").update(key.serialize()).digest("hex").slice(0, 16);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

interface SignalAiClientInit {
  transport: Transport;
  token: string;
  userId: string;
  username: string;
  deviceId: number;
  identity: Identity;
  stores: ClientStores;
  provisioned: ProvisionedPreKeys;
  nextOneTimePreKeyId: number;
  /** When true, {@link ensureSession} may fetch a peer's prekey bundle by opaque `userId` (not just by resolved `username`) — see the class doc. Default false. */
  autoResolveMembersById?: boolean;
}

/**
 * A headless signal-ai client: owns one Signal-protocol identity + prekeys,
 * speaks the relay's REST + WS contract via a pluggable {@link Transport},
 * and layers conversation/session bookkeeping on top of `@signalai/core`'s
 * crypto primitives (no cryptography is implemented here).
 *
 * **Contacts model**: the relay only supports prekey-bundle lookup by
 * `username` (`GET /users/:username/bundle`), while every other relay
 * operation (create/invite/remove/listMembers) is keyed by the opaque
 * `userId`. There is no relay endpoint to resolve an arbitrary `userId` back
 * to a `username`. So: {@link resolveUser} is the SDK's contact-book
 * primitive — call it once per peer (by username) before you can send to
 * them — mirroring "add contact" in real E2EE messengers. `createConversation`
 * /`invite`/`removeMember` take `userId`s (matching the relay 1:1) once a
 * peer has been resolved.
 */
export class SignalAiClient {
  onMessage: SignalAiClientHandlers["onMessage"];
  onSystemEvent: SignalAiClientHandlers["onSystemEvent"];
  onConnectionChange: SignalAiClientHandlers["onConnectionChange"];

  readonly stores: ClientStores;
  /** The underlying pairwise fan-out/decrypt engine — exposed directly so callers (and tests) can drive decrypt semantics without going through the WS/relay path. */
  readonly fanout: GroupFanout;

  private readonly transport: Transport;
  private readonly sessionManager: SessionManager;
  private readonly address: DeviceAddress;
  private readonly identity: Identity;
  private readonly signedPreKeyRecord: ReturnType<typeof PrekeyManager.generateSignedPreKey>;
  private readonly kyberPreKeyRecord: ReturnType<typeof PrekeyManager.generateKyberPreKey>;
  private tokenValue: string;
  private nextOneTimePreKeyId: number;
  private readonly autoResolveMembersById: boolean;
  private link: WsLink | undefined;
  private connectionStateValue: ConnectionState = "disconnected";
  private inbox: Promise<void> = Promise.resolve();
  private identityChangeLogCursor = 0;
  readonly username: string;

  private constructor(init: SignalAiClientInit) {
    this.transport = init.transport;
    this.tokenValue = init.token;
    this.address = { userId: init.userId, deviceId: init.deviceId };
    this.identity = init.identity;
    this.stores = init.stores;
    this.signedPreKeyRecord = init.provisioned.signedPreKey;
    this.kyberPreKeyRecord = init.provisioned.kyberPreKey;
    this.nextOneTimePreKeyId = init.nextOneTimePreKeyId;
    this.autoResolveMembersById = init.autoResolveMembersById ?? false;
    this.sessionManager = new SessionManager(this.address, init.stores);
    this.fanout = new GroupFanout(this.sessionManager);
    this.username = init.username;
  }

  get userId(): string {
    return this.address.userId;
  }
  get deviceId(): number {
    return this.address.deviceId;
  }
  get connectionState(): ConnectionState {
    return this.connectionStateValue;
  }
  /** The raw relay bearer token, for advanced/test use (e.g. driving a second raw connection as this same identity). */
  get token(): string {
    return this.tokenValue;
  }
  /** This device's serialized identity key pair + registration id — persist alongside {@link stores}.toJSON() so the account can later {@link SignalAiClient.resume}. */
  get serializedIdentity(): { identityKeyPair: Uint8Array; registrationId: number } {
    return this.identity.serialize();
  }
  /** The next one-time-prekey id this device would allocate — persist for {@link SignalAiClient.resume} so ids don't collide after a restart. */
  get nextPreKeyId(): number {
    return this.nextOneTimePreKeyId;
  }

  /** Generates+publishes a batch of one-time prekeys, reusing the device's existing signed/kyber prekeys. Relay only accepts one OTP per `POST /devices` call, so this is `count` sequential requests. */
  private async provisionAndPublishOtps(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      const [otp] = PrekeyManager.generateOneTimePreKeys(this.nextOneTimePreKeyId, 1);
      this.nextOneTimePreKeyId += 1;
      await this.stores.preKey.savePreKey(otp!.id(), otp!);
      const bundle = PrekeyManager.buildBundle({
        registrationId: this.identity.registrationId,
        deviceId: this.deviceId,
        identityKey: this.identity.keyPair.publicKey,
        signedPreKey: this.signedPreKeyRecord,
        kyberPreKey: this.kyberPreKeyRecord,
        oneTimePreKey: otp!,
      });
      await this.transport.publishDevice(this.tokenValue, this.userId, bundleToWire(bundle, this.userId));
    }
  }

  private static async provisionIdentityAndPublish(
    transport: Transport,
    token: string,
    userId: string,
    deviceId: number,
    identity: Identity,
    stores: ClientStores,
    otpCount: number,
  ): Promise<ProvisionedPreKeys> {
    const provisioned = await PrekeyManager.provision(stores, identity.keyPair.privateKey, {
      signedPreKeyId: 1,
      kyberPreKeyId: 1,
      oneTimePreKeyStartId: 1,
      oneTimePreKeyCount: otpCount,
    });
    for (const otp of provisioned.oneTimePreKeys) {
      const bundle = PrekeyManager.buildBundle({
        registrationId: identity.registrationId,
        deviceId,
        identityKey: identity.keyPair.publicKey,
        signedPreKey: provisioned.signedPreKey,
        kyberPreKey: provisioned.kyberPreKey,
        oneTimePreKey: otp,
      });
      await transport.publishDevice(token, userId, bundleToWire(bundle, userId));
    }
    return provisioned;
  }

  /** Creates a brand-new relay account (`POST /signup`), provisions + publishes its device bundle, and connects. */
  static async signup(params: {
    relayUrl: string;
    inviteCode: string;
    username: string;
    deviceId?: number;
    stores?: ClientStores;
    transport?: Transport;
    initialOneTimePreKeyCount?: number;
    autoResolveMembersById?: boolean;
  }): Promise<SignalAiClient> {
    const transport = params.transport ?? createHttpWsTransport(params.relayUrl);
    const identity = Identity.generate();
    const deviceId = params.deviceId ?? 1;
    const stores = params.stores ?? InMemoryClientStores.create(identity);
    const otpCount = params.initialOneTimePreKeyCount ?? DEFAULT_INITIAL_OTP_COUNT;

    const { userId, token } = await transport.signup({ inviteCode: params.inviteCode, username: params.username });
    const provisioned = await SignalAiClient.provisionIdentityAndPublish(
      transport,
      token,
      userId,
      deviceId,
      identity,
      stores,
      otpCount,
    );

    const client = new SignalAiClient({
      transport,
      token,
      userId,
      username: params.username,
      deviceId,
      identity,
      stores,
      provisioned,
      nextOneTimePreKeyId: otpCount + 1,
      autoResolveMembersById: params.autoResolveMembersById ?? false,
    });
    await client.connect();
    return client;
  }

  /**
   * Reconnects an EXISTING relay account from persisted state (identity +
   * ratchet + client bookkeeping), WITHOUT re-provisioning or rotating any
   * keys. This is a true restart/reinstall-of-the-same-device: the ratchet
   * resumes exactly where it left off, so any envelope the relay redelivers on
   * reconnect decrypts cleanly. Contrast {@link signup} / {@link reregisterDevice},
   * which both generate a fresh identity and PUBLISH new bundles — `resume`
   * publishes NOTHING (republishing would rotate this device's signed/kyber
   * prekeys server-side and break peers mid-session).
   *
   * `serializedStores` + `serializedIdentity` + `nextOneTimePreKeyId` are what
   * a durable store (e.g. SQLite) round-trips; get them from
   * {@link stores}.toJSON(), {@link serializedIdentity}, and
   * {@link nextPreKeyId} before shutdown.
   */
  static async resume(params: {
    relayUrl: string;
    token: string;
    userId: string;
    username: string;
    deviceId?: number;
    serializedIdentity: { identityKeyPair: Uint8Array; registrationId: number };
    serializedStores: SerializedClientStores;
    nextOneTimePreKeyId: number;
    transport?: Transport;
    autoResolveMembersById?: boolean;
  }): Promise<SignalAiClient> {
    const transport = params.transport ?? createHttpWsTransport(params.relayUrl);
    const deviceId = params.deviceId ?? 1;
    const identity = Identity.fromSerialized(
      params.serializedIdentity.identityKeyPair,
      params.serializedIdentity.registrationId,
    );
    const stores = InMemoryClientStores.fromJSON(params.serializedStores);

    // Reconstruct the ProvisionedPreKeys the constructor needs (only the
    // signed+kyber records are read post-construction — see the constructor
    // and provisionAndPublishOtps). Read them back out of the rehydrated
    // stores under whatever ids they were saved at (single source of truth;
    // no re-generation, no re-publish). oneTimePreKeys aren't retained.
    const signedPreKeyId = params.serializedStores.signedPreKeys[0]?.id;
    const kyberPreKeyId = params.serializedStores.kyberPreKeys[0]?.id;
    if (signedPreKeyId === undefined || kyberPreKeyId === undefined) {
      throw new Error("resume: serialized stores are missing the signed/kyber prekey record needed to reconnect");
    }
    const provisioned: ProvisionedPreKeys = {
      signedPreKey: await stores.signedPreKey.getSignedPreKey(signedPreKeyId),
      kyberPreKey: await stores.kyberPreKey.getKyberPreKey(kyberPreKeyId),
      oneTimePreKeys: [],
    };

    const client = new SignalAiClient({
      transport,
      token: params.token,
      userId: params.userId,
      username: params.username,
      deviceId,
      identity,
      stores,
      provisioned,
      nextOneTimePreKeyId: params.nextOneTimePreKeyId,
      autoResolveMembersById: params.autoResolveMembersById ?? false,
    });
    await client.connect();
    return client;
  }

  /**
   * Simulates a device reinstall: the SAME relay account (`userId`+`token`
   * from a prior signup) gets a brand-new identity + prekey set published via
   * `POST /devices` only (skipping `/signup`, which is one-time per
   * username). This is how a peer's identity key actually changes in this
   * system — used to exercise `identityKeyChanged` detection.
   */
  static async reregisterDevice(params: {
    relayUrl: string;
    userId: string;
    token: string;
    username: string;
    deviceId?: number;
    stores?: ClientStores;
    transport?: Transport;
    initialOneTimePreKeyCount?: number;
  }): Promise<SignalAiClient> {
    const transport = params.transport ?? createHttpWsTransport(params.relayUrl);
    const identity = Identity.generate();
    const deviceId = params.deviceId ?? 1;
    const stores = params.stores ?? InMemoryClientStores.create(identity);
    const otpCount = params.initialOneTimePreKeyCount ?? DEFAULT_INITIAL_OTP_COUNT;

    const provisioned = await SignalAiClient.provisionIdentityAndPublish(
      transport,
      params.token,
      params.userId,
      deviceId,
      identity,
      stores,
      otpCount,
    );

    const client = new SignalAiClient({
      transport,
      token: params.token,
      userId: params.userId,
      username: params.username,
      deviceId,
      identity,
      stores,
      provisioned,
      nextOneTimePreKeyId: otpCount + 1,
    });
    await client.connect();
    return client;
  }

  /**
   * Opens (or reopens) the WS connection; resolves once the relay's `ready`
   * frame arrives. Auto-reconnects with backoff on unexpected close. No
   * client-driven polling is needed for delivery: the relay live-pushes to
   * any open, authenticated recipient socket on `send` (see
   * `apps/relay/src/index.ts`'s `liveSockets` registry), and automatically
   * drains this device's offline mailbox once, right after every `ready`.
   */
  async connect(): Promise<void> {
    this.link?.disconnect();
    this.link = new WsLink(this.transport, this.tokenValue, this.deviceId, {
      onReady: () => {},
      onDeliver: (envelope) => this.enqueueIncoming(envelope),
      onStateChange: (state) => {
        this.connectionStateValue = state;
        this.onConnectionChange?.(state);
      },
    });
    await this.link.connect();
  }

  /** Intentionally disconnects; no auto-reconnect happens until `connect()` is called again. */
  disconnect(): void {
    this.link?.disconnect();
  }

  private enqueueIncoming(envelope: Envelope): void {
    this.inbox = this.inbox.then(() => this.handleIncomingEnvelope(envelope)).catch(() => undefined);
  }

  /**
   * Resolves a `username` into its relay `userId` + registered `deviceIds`,
   * caching the mapping (this client's "contact book") and eagerly
   * establishing/refreshing a session with each of that user's devices from
   * the bundle(s) just fetched. Must be called at least once per peer before
   * {@link send} can address them for the first time.
   */
  async resolveUser(username: string): Promise<{ userId: string; deviceIds: number[] }> {
    const bundles = await this.transport.fetchBundles(this.tokenValue, username);
    if (bundles.length === 0) {
      throw new Error(`resolveUser: relay has no registered devices for username "${username}"`);
    }
    const userId = bundles[0]!.userId;
    const deviceIds = bundles.map((b) => b.deviceId);
    this.stores.directory.set(userId, { username, deviceIds });

    for (const wireBundle of bundles) {
      const remote: DeviceAddress = { userId, deviceId: wireBundle.deviceId };
      await this.establishOrRefreshSession(remote, wireBundle);
    }
    return { userId, deviceIds };
  }

  /**
   * Establishes a session from `wireBundle` unless one already exists AND the
   * bundle's identity key matches what's already on file — i.e. this is a
   * no-op on repeat calls, but re-keys (and, via `saveIdentity`, surfaces
   * `identityKeyChanged`) when a peer's identity key has visibly changed.
   */
  private async establishOrRefreshSession(remote: DeviceAddress, wireBundle: PreKeyBundlePublic): Promise<void> {
    const protoAddr = toProtocolAddress(remote);
    const knownKey = await this.stores.identity.getIdentity(protoAddr);
    const newKeyBytes = fromBase64(wireBundle.identityKey);
    const keyChanged = knownKey !== null && !bytesEqual(knownKey.serialize(), newKeyBytes);
    const hasSession = (await this.stores.session.getSession(protoAddr)) !== null;
    if (hasSession && !keyChanged) return;

    await this.sessionManager.establishSession(remote, bundleFromWire(wireBundle));
    this.drainIdentityChangeLog();
  }

  private async ensureSession(remote: DeviceAddress): Promise<void> {
    const hasSession = (await this.stores.session.getSession(toProtocolAddress(remote))) !== null;
    if (hasSession) return;
    const contact = this.stores.directory.get(remote.userId);
    if (!contact) {
      // No resolved username. The human CLI (default) refuses here — it wants
      // an explicit resolveUser(username) first so the trust surface (safety
      // numbers) is anchored to a username. A headless member (the AI agent)
      // opts into `autoResolveMembersById` to instead fetch the bundle by the
      // opaque userId it learned from listMembers, so it can reply to a
      // co-member it was never introduced to by name.
      if (this.autoResolveMembersById) {
        const bundlesById = await this.transport.fetchBundlesByUserId(this.tokenValue, remote.userId, remote.deviceId);
        const wireBundleById = bundlesById.find((b) => b.deviceId === remote.deviceId);
        if (!wireBundleById) {
          throw new Error(
            `ensureSession: relay returned no prekey bundle for userId "${remote.userId}"/device ${remote.deviceId}`,
          );
        }
        await this.establishOrRefreshSession(remote, wireBundleById);
        return;
      }
      throw new Error(
        `ensureSession: no session and no resolved username for userId "${remote.userId}" — call resolveUser() for this contact before sending`,
      );
    }
    const bundles = await this.transport.fetchBundles(this.tokenValue, contact.username, remote.deviceId);
    const wireBundle = bundles.find((b) => b.deviceId === remote.deviceId);
    if (!wireBundle) {
      throw new Error(`ensureSession: relay returned no prekey bundle for ${contact.username}/device ${remote.deviceId}`);
    }
    await this.establishOrRefreshSession(remote, wireBundle);
  }

  private drainIdentityChangeLog(): void {
    const log = this.stores.identity.changeLog;
    for (; this.identityChangeLogCursor < log.length; this.identityChangeLogCursor++) {
      const entry = log[this.identityChangeLogCursor]!;
      if (entry.change !== IDENTITY_CHANGE_REPLACED_EXISTING) continue;
      const dot = entry.address.lastIndexOf(".");
      const userId = entry.address.slice(0, dot);
      const deviceId = Number(entry.address.slice(dot + 1));
      this.onSystemEvent?.({ type: "identityKeyChanged", userId, deviceId });
    }
  }

  async createConversation(memberUserIds: string[], opts: { aiMode?: boolean } = {}): Promise<string> {
    const aiMode = opts.aiMode ?? false;
    const conversationId = await this.transport.createConversation(this.tokenValue, {
      creatorUserId: this.userId,
      memberUserIds,
      aiMode,
    });
    this.stores.conversations.set(conversationId, {
      members: new Map([[this.userId, { deviceIds: [this.deviceId], joinedAt: Date.now() }]]),
      aiMode,
      adminUserId: this.userId,
    });
    await this.listMembers(conversationId).catch(() => undefined);
    return conversationId;
  }

  async invite(conversationId: string, userId: string): Promise<void> {
    await this.transport.invite(this.tokenValue, conversationId, userId);
    await this.listMembers(conversationId).catch(() => undefined);
  }

  async removeMember(conversationId: string, userId: string): Promise<void> {
    await this.transport.removeMember(this.tokenValue, conversationId, userId);
    await this.listMembers(conversationId).catch(() => undefined);
  }

  async setAiMode(conversationId: string, enabled: boolean): Promise<void> {
    await this.transport.setAiMode(this.tokenValue, conversationId, enabled);
    const cached = this.stores.conversations.get(conversationId);
    if (cached) cached.aiMode = enabled;
    // Local self-echo: surface the toggle immediately to THIS client's own
    // listeners. Cross-client observation is handled separately (post-6A the
    // relay returns aiMode from GET /conversations/:id/members, so a peer's
    // listMembers refresh syncs it — see listMembers below); this event is not
    // that path, it only reflects the caller's own optimistic set.
    this.onSystemEvent?.({ type: "aiModeChanged", conversationId, enabled });
  }

  /** Current cached AI mode for a conversation (refreshed by {@link listMembers}). */
  getAiMode(conversationId: string): boolean {
    return this.stores.conversations.get(conversationId)?.aiMode ?? false;
  }

  /**
   * Fetches current membership from the relay, diffs it against the local
   * cache (emitting `memberJoined`/`memberRemoved` for changes since the last
   * call), and returns the flattened, fingerprint-enriched {@link Member} list.
   */
  async listMembers(conversationId: string): Promise<Member[]> {
    const resp = await this.transport.listMembers(this.tokenValue, conversationId);
    const raw = resp.members;
    let cached = this.stores.conversations.get(conversationId);
    if (!cached) {
      cached = { members: new Map(), aiMode: resp.aiMode };
      this.stores.conversations.set(conversationId, cached);
    }
    // Sync mode from the relay on EVERY refresh so a peer's `setAiMode` toggle
    // propagates here (the phase-6 human→agent path). setAiMode's optimistic
    // local set is not a regression: the relay is synchronous, so a subsequent
    // listMembers returns the same value.
    cached.aiMode = resp.aiMode;

    const now = Date.now();
    const seenUserIds = new Set<string>();
    for (const m of raw) {
      seenUserIds.add(m.userId);
      const existing = cached.members.get(m.userId);
      if (!existing) {
        cached.members.set(m.userId, { deviceIds: m.deviceIds, joinedAt: now });
        if (m.userId !== this.userId) {
          for (const deviceId of m.deviceIds) {
            this.onSystemEvent?.({ type: "memberJoined", conversationId, userId: m.userId, deviceId });
          }
        }
      } else {
        existing.deviceIds = m.deviceIds;
      }
    }
    for (const userId of [...cached.members.keys()]) {
      if (!seenUserIds.has(userId)) {
        cached.members.delete(userId);
        if (userId !== this.userId) this.onSystemEvent?.({ type: "memberRemoved", conversationId, userId });
      }
    }

    const members: Member[] = [];
    for (const m of raw) {
      const cachedEntry = cached.members.get(m.userId)!;
      for (const deviceId of m.deviceIds) {
        const known = await this.stores.identity.getIdentity(toProtocolAddress({ userId: m.userId, deviceId }));
        members.push({
          userId: m.userId,
          deviceId,
          identityKeyFingerprint: fingerprintOf(known),
          joinedAt: cachedEntry.joinedAt,
          role: cached.adminUserId === m.userId ? "admin" : "member",
        });
      }
    }
    return members;
  }

  /** Encrypts+sends `text` to every current member of `conversationId` (via pairwise fan-out), returning the generated `msgId`. */
  async send(conversationId: string, text: string, mentions: string[] = []): Promise<string> {
    const msgId = randomUUID();
    const plaintext: PlaintextMessage = { msgId, text, mentions, sentAt: Date.now() };
    await this.sendRaw(conversationId, plaintext);
    return msgId;
  }

  /** Lower-level `send`: encrypts+sends an already-constructed {@link PlaintextMessage} (e.g. to resend the same `msgId` after a dropped ack). */
  async sendRaw(conversationId: string, plaintext: PlaintextMessage): Promise<void> {
    parsePlaintextMessage(plaintext);

    const members = await this.listMembers(conversationId);
    const targets: DeviceAddress[] = members
      .filter((m) => m.userId !== this.userId)
      .map((m) => ({ userId: m.userId, deviceId: m.deviceId }));

    for (const target of targets) await this.ensureSession(target);

    const bytes = new TextEncoder().encode(JSON.stringify(plaintext));
    const envelopes = await this.fanout.encryptForMembers(bytes, targets, {
      conversationId,
      senderUserId: this.userId,
      senderDeviceId: this.deviceId,
    });

    if (!this.link?.isReady) throw new Error("send: not connected to the relay");
    for (let i = 0; i < envelopes.length; i++) {
      const recipientUserId = targets[i]!.userId;
      this.link.send({ type: "send", recipientUserId, envelope: envelopes[i]! });
    }
  }

  /**
   * Decrypts, dedupes, and dispatches a single incoming Envelope — the same
   * path the WS `deliver` handler drives. Public so callers/tests can feed it
   * a hand-constructed Envelope directly (e.g. to prove sender-authenticity:
   * `decryptEnvelope` picks the session from `envelope.senderUserId`, so a
   * forged sender field decrypts against the wrong/no session and throws —
   * this method catches that and drops the message silently, never invoking
   * `onMessage` for an unverified sender).
   */
  async handleIncomingEnvelope(envelope: Envelope): Promise<void> {
    let plaintextBytes: Uint8Array;
    try {
      plaintextBytes = await this.fanout.decryptEnvelope(envelope);
    } catch {
      return; // wrong/no session for the claimed sender, corrupt ciphertext, or an already-consumed message key — never surface it.
    }
    this.drainIdentityChangeLog();

    let message: PlaintextMessage;
    try {
      message = parsePlaintextMessage(JSON.parse(new TextDecoder().decode(plaintextBytes)) as unknown);
    } catch {
      this.safeAck(envelope.conversationId, envelope.seq);
      return;
    }

    if (!this.stores.seenMsgIds.has(message.msgId)) {
      this.stores.seenMsgIds.add(message.msgId);
      if (!this.stores.conversations.has(envelope.conversationId)) {
        await this.listMembers(envelope.conversationId).catch(() => undefined);
      }
      // Surfacing the envelope's self-declared sender is safe ONLY because the
      // decrypt above (fanout.decryptEnvelope) selected the pairwise session
      // from these same senderUserId/senderDeviceId fields: a forged sender
      // decrypts against the wrong/no session and throws before we ever reach
      // here, so a value that survives to onMessage is authenticated by the
      // ratchet, not merely echoed from the wire.
      this.onMessage?.({
        conversationId: envelope.conversationId,
        senderUserId: envelope.senderUserId,
        senderDeviceId: envelope.senderDeviceId,
        text: message.text,
        mentions: message.mentions,
        sentAt: message.sentAt,
        msgId: message.msgId,
      });
    }

    this.safeAck(envelope.conversationId, envelope.seq);
  }

  private safeAck(conversationId: string, seq: number): void {
    if (this.link?.isReady) this.link.send({ type: "ack", conversationId, seq });
  }

  /**
   * The relay has no side-effect-free way to read back this device's
   * remaining one-time-prekey count (`GET /users/:username/bundle` is the
   * only observable signal, and fetching it consumes an OTP if one is
   * present). So this "peeks" via that endpoint: if the peek finds no OTP
   * left, it replenishes a fresh batch. Because the peek itself can consume
   * the last available OTP, call this sparingly (e.g. after `connect()`/on
   * an infrequent timer) rather than on every message.
   */
  async checkAndReplenishPrekeys(batchSize = DEFAULT_REPLENISH_BATCH): Promise<boolean> {
    const bundles = await this.transport.fetchBundles(this.tokenValue, this.username, this.deviceId);
    const mine = bundles.find((b) => b.deviceId === this.deviceId);
    if (mine?.preKeyId !== undefined) return false;
    await this.provisionAndPublishOtps(batchSize);
    return true;
  }
}
