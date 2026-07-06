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
  toBase64,
  type DeviceAddress,
  type ProvisionedPreKeys,
} from "@signalai/core";
import { parsePlaintextMessage, type PlaintextMessage, type Envelope, type PreKeyBundlePublic, type WsOpDeliverFrame } from "@signalai/proto";
import {
  OpLogMembershipService,
  MembershipLog,
  decodeOp,
  encodeOp,
  enforceInbound,
  parseInvitePin,
  serializeInvitePin,
  type InvitePin,
  type OpBroadcaster,
  type MembershipOp,
} from "@signalai/membership";
import type { Transport } from "./transport.js";
import { resolveTransport, type TransportMode } from "./transport-select.js";
import type { P2pTransportOptions } from "./transport-p2p.js";
import { DuplexLink } from "./connection.js";
import { InMemoryClientStores, appendMembershipOp, type ClientStores, type SerializedClientStores } from "./stores.js";
import type { ConnectionState, Member, SignalAiClientHandlers } from "./types.js";

const DEFAULT_INITIAL_OTP_COUNT = 5;
const DEFAULT_REPLENISH_BATCH = 5;
/** Bound for a one-shot late-join op-log catch-up: total wait and poll interval (ms). */
const OP_CATCHUP_TIMEOUT_MS = 3000;
const OP_CATCHUP_POLL_MS = 50;

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
  private link: DuplexLink | undefined;
  private connectionStateValue: ConnectionState = "disconnected";
  private inbox: Promise<void> = Promise.resolve();
  private identityChangeLogCursor = 0;
  /**
   * Conversations for which this session has already fired a one-shot
   * late-join op-log catch-up `subscribe` (see {@link listMembers}). Bounds
   * the backfill to ONE relay resync per conversation per session so the
   * hot-path callers of `listMembers` can never storm the relay.
   */
  private readonly opCatchupAttempted = new Set<string>();
  /**
   * Out-of-band {@link InvitePin}s this session has accepted (design §4 TOFU),
   * keyed by conversationId. When a pin is present, {@link membershipLogFor}
   * rebuilds the receiver log via {@link MembershipLog.forJoiner} instead of the
   * unpinned {@link MembershipLog.open}, so a relay that serves a forged or
   * truncated genesis is REJECTED at the joiner rather than blindly trusted. A
   * conversation with NO seeded pin keeps the legacy accepted-risk behavior
   * (relay-served genesis is trusted) — see {@link acceptInvitePin}.
   */
  private readonly joinPins = new Map<string, InvitePin>();
  /**
   * This client's op-log AUTHOR-side seam (design gotcha #1, Phase A.2): only
   * the conversation creator ever successfully authors through it (its
   * internal `chains` map only knows conversations THIS instance created via
   * {@link createConversation}) — a non-creator's authoring calls fail closed
   * and are swallowed by {@link authorMembershipOp}, leaving the relay REST
   * call as the sole effect for that pass. Every client (author or not) still
   * owns a RECEIVER-side chain via `stores.conversations.get(id).membershipOps`
   * (see {@link handleIncomingOp} / {@link membershipLogFor}) — constructed
   * once {@link connect} has a `link` to broadcast over, and never rebuilt on
   * reconnect (its internal chain state must survive reconnects).
   */
  private membershipService: OpLogMembershipService | undefined;
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
    transportMode?: TransportMode;
    p2pTransport?: P2pTransportOptions;
    initialOneTimePreKeyCount?: number;
    autoResolveMembersById?: boolean;
  }): Promise<SignalAiClient> {
    const transport = params.transport ?? resolveTransport({ relayUrl: params.relayUrl, mode: params.transportMode, p2p: params.p2pTransport });
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
    transportMode?: TransportMode;
    p2pTransport?: P2pTransportOptions;
    autoResolveMembersById?: boolean;
  }): Promise<SignalAiClient> {
    const transport = params.transport ?? resolveTransport({ relayUrl: params.relayUrl, mode: params.transportMode, p2p: params.p2pTransport });
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
    transportMode?: TransportMode;
    p2pTransport?: P2pTransportOptions;
    initialOneTimePreKeyCount?: number;
  }): Promise<SignalAiClient> {
    const transport = params.transport ?? resolveTransport({ relayUrl: params.relayUrl, mode: params.transportMode, p2p: params.p2pTransport });
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
    this.link = new DuplexLink(this.transport, this.tokenValue, this.deviceId, {
      onReady: () => {},
      onDeliver: (envelope) => this.enqueueIncoming(envelope),
      onOp: (frame) => this.handleIncomingOp(frame),
      onStateChange: (state) => {
        this.connectionStateValue = state;
        this.onConnectionChange?.(state);
      },
    });
    await this.link.connect();
    // Constructed once, lazily, the first time a link exists — NOT rebuilt on
    // reconnect, since it holds the author-side chain state in memory
    // (design gotcha #1/#2). The broadcaster reads `this.link` at call time
    // (not captured at construction), so it always sends over the CURRENT
    // link even after a later reconnect replaces `this.link`.
    if (!this.membershipService) {
      const broadcaster: OpBroadcaster = {
        broadcastOp: (conversationId, encodedOp) => {
          const { seq } = decodeOp(encodedOp);
          this.link!.send({ type: "op-send", conversationId, seq, op: toBase64(encodedOp) });
        },
      };
      this.membershipService = new OpLogMembershipService(this.identity, this.userId, broadcaster);
    }
  }

  /** Intentionally disconnects; no auto-reconnect happens until `connect()` is called again. */
  disconnect(): void {
    this.link?.disconnect();
  }

  private enqueueIncoming(envelope: Envelope): void {
    this.inbox = this.inbox.then(() => this.handleIncomingEnvelope(envelope)).catch(() => undefined);
  }

  /**
   * Rebuilds this conversation's RECEIVER-side {@link MembershipLog} from the
   * persisted base64 chain (`stores.conversations.get(id).membershipOps`) —
   * the source of truth, so a cold-load (`toJSON`/`fromJSON` round-trip)
   * reproduces the same log (Phase A.2 / A-3). Returns `undefined` if no ops
   * have been accumulated yet. Consumed by both the Phase B stamp (`sendRaw`)
   * and the Phase B receiver gate (`handleIncomingEnvelope` -> `enforceInbound`).
   */
  membershipLogFor(conversationId: string): MembershipLog | undefined {
    const cached = this.stores.conversations.get(conversationId);
    if (!cached || cached.membershipOps.length === 0) return undefined;
    const chain: MembershipOp[] = cached.membershipOps.map((encoded) => decodeOp(fromBase64(encoded)));
    const pin = this.joinPins.get(conversationId);
    try {
      // Pinned joiner (design §4 TOFU): forJoiner enforces genesis-hash match +
      // pinned (seq, headHash) presence + non-regression, so a forged/truncated
      // genesis throws here. Unpinned: legacy accepted-risk `open`.
      if (pin) {
        const log = MembershipLog.forJoiner(pin);
        log.ingestChain(chain);
        return log;
      }
      return MembershipLog.open(chain);
    } catch {
      // The persisted chain no longer verifies (or violates the seeded pin).
      // Fail closed: report "no usable chain" so the gate drops rather than
      // trusting an unverifiable/forged log. Also the roll-back signal for
      // {@link handleIncomingOp}. Never surface a partial/forged view.
      return undefined;
    }
  }

  /**
   * One-shot, BOUNDED late-join op-log catch-up (design §4 / late-join gap).
   * Shared by site A ({@link listMembers}) and site B ({@link handleIncomingEnvelope})
   * so the 3s busy-poll lives in exactly one place. Fires ONE relay resync
   * `subscribe` per conversation per session (bounded by {@link opCatchupAttempted}),
   * then polls — bounded by {@link OP_CATCHUP_TIMEOUT_MS} — until the chain
   * populates. Cancels early if the link drops mid-wait (a disconnected socket
   * will never deliver the drained ops, so spinning the full deadline is
   * pointless). Returns the rebuilt log (pin-aware) or undefined if it never
   * arrived. Callers still run the fail-closed gate on whatever this returns.
   */
  private async awaitChainReady(conversationId: string): Promise<MembershipLog | undefined> {
    if (
      !this.link?.isReady ||
      this.membershipLogFor(conversationId) !== undefined ||
      this.opCatchupAttempted.has(conversationId)
    ) {
      return this.membershipLogFor(conversationId);
    }
    this.opCatchupAttempted.add(conversationId);
    this.link.subscribe(conversationId); // relay drainAndPush: ops from seq 0 (+ envelopes; dedup handles replays).
    const deadline = Date.now() + OP_CATCHUP_TIMEOUT_MS;
    while (Date.now() < deadline && this.membershipLogFor(conversationId) === undefined) {
      if (!this.link?.isReady) break; // link dropped — no ops will arrive; stop waiting.
      await new Promise((r) => setTimeout(r, OP_CATCHUP_POLL_MS)); // yields to the WS handler that applies inbound op frames.
    }
    return this.membershipLogFor(conversationId);
  }

  /**
   * Receive path for an incoming `op-deliver` frame (Phase A.2, design gotcha
   * #2): decodes+validates the single op, appends it to the persisted
   * per-conversation chain (idempotent/dense — {@link appendMembershipOp}),
   * then rebuilds the full receiver {@link MembershipLog} to independently
   * verify the chain still holds together end to end. A bad/forged op (or one
   * that breaks the hash chain) is dropped and the append rolled back rather
   * than left in a state that would never verify. Ops are membership
   * metadata, not chat — never dispatched to `onMessage`, and bypass the
   * envelope `inbox` mutex (independently verified + idempotent), but still
   * processed one at a time per DuplexLink's single onMessage callback so
   * ordering per conversation holds.
   */
  private handleIncomingOp(frame: WsOpDeliverFrame): void {
    try {
      decodeOp(fromBase64(frame.op));
    } catch {
      return; // not a real op — drop.
    }

    let cached = this.stores.conversations.get(frame.conversationId);
    if (!cached) {
      cached = { members: new Map(), aiMode: false, membershipOps: [] };
      this.stores.conversations.set(frame.conversationId, cached);
    }
    if (!appendMembershipOp(cached, frame.seq, frame.op)) return; // dup or gap — reconnect re-drain recovers gaps.

    // `membershipLogFor` returns undefined when the assembled chain no longer
    // verifies OR violates a seeded out-of-band pin (forged/truncated genesis).
    // Either way roll the op back so persisted state stays valid + pin-consistent.
    if (this.membershipLogFor(frame.conversationId) === undefined) {
      cached.membershipOps.pop();
      console.debug(`membership: rejected an op for conversation ${frame.conversationId} at seq ${frame.seq}`);
    }
  }

  /**
   * Authors a membership op via {@link membershipService} and, on success,
   * syncs this client's own receiver-side chain from the service's
   * authoritative view. Swallows failures silently: only the conversation
   * CREATOR's service instance knows the conversation (design gotcha #1) — a
   * non-creator calling this throws `IntegrityError` internally, which is
   * expected and not special-cased (spec step 5) — the relay REST call the
   * caller already made remains the effective, unchanged behavior for that
   * case in this pass.
   */
  private async authorMembershipOp(conversationId: string, author: () => Promise<void>): Promise<void> {
    if (!this.membershipService) return;
    try {
      await author();
      this.syncOwnMembershipChain(conversationId);
    } catch {
      // Not this client's op-log to author (non-creator), or the service
      // never observed this conversation's genesis — best-effort in Phase A.
    }
  }

  /** Syncs this client's own persisted receiver chain from {@link membershipService}'s authoritative chain for `conversationId` (author-side self-sync, design gotcha #2: the relay fan-out excludes the sender, so an author never receives its own op back over the wire). */
  private syncOwnMembershipChain(conversationId: string): void {
    if (!this.membershipService) return;
    let chain: MembershipOp[];
    try {
      chain = this.membershipService.chainFor(conversationId);
    } catch {
      return;
    }
    const cached = this.stores.conversations.get(conversationId);
    if (!cached) return;
    for (let seq = cached.membershipOps.length; seq < chain.length; seq++) {
      appendMembershipOp(cached, seq, toBase64(encodeOp(chain[seq]!)));
    }
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
      membershipOps: [],
    });
    // Dual-write (Phase A.2): the relay call above remains the source of
    // truth for this pass; the op-log genesis adopts the SAME conversationId
    // (step 5b's additive param) so a receiver's chain binds to it too.
    await this.authorMembershipOp(conversationId, async () => {
      await this.membershipService!.createConversation(
        this.tokenValue,
        { creatorUserId: this.userId, memberUserIds, aiMode },
        conversationId,
      );
    });
    await this.listMembers(conversationId).catch(() => undefined);
    return conversationId;
  }

  async invite(conversationId: string, userId: string): Promise<void> {
    await this.transport.invite(this.tokenValue, conversationId, userId);
    await this.authorMembershipOp(conversationId, () => this.membershipService!.invite(this.tokenValue, conversationId, userId));
    await this.listMembers(conversationId).catch(() => undefined);
  }

  /**
   * Builds the OUT-OF-BAND {@link InvitePin} for a joiner (design §4 TOFU): a
   * serialized `{ conversationId, genesisHash, pinnedHead }` the inviter hands
   * the joiner over a channel the relay does NOT control (invite link, QR,
   * safety-number-style exchange). The joiner feeds it to {@link acceptInvitePin}
   * BEFORE its late-join catch-up so a forged/truncated relay-served genesis is
   * rejected instead of trusted. Only the conversation CREATOR's client can
   * produce a pin (its op-log author-side seam holds the chain); a non-creator
   * call throws — surface it to the caller rather than emitting an unpinnable
   * invite silently. Returns a string safe to transmit out-of-band (no secrets:
   * a pin is a public trusted-lower-bound, not a capability).
   */
  invitePinFor(conversationId: string): string {
    if (!this.membershipService) throw new Error("membership op-log unavailable — connect() first");
    return serializeInvitePin(this.membershipService.inviteFor(conversationId));
  }

  /**
   * Seeds an out-of-band {@link InvitePin} received from the inviter (design §4
   * TOFU). Once seeded, {@link membershipLogFor} rebuilds this conversation's
   * receiver log via `MembershipLog.forJoiner`, so any relay-served chain whose
   * genesis hash or pinned `(seq, headHash)` doesn't match is REJECTED (a
   * forged/truncated genesis fails closed instead of being trusted). Call this
   * BEFORE joining / receiving the first message. Throws if the pin string is
   * malformed — a joiner must refuse a pin it cannot fully validate. Absence of
   * a seeded pin keeps the legacy accepted-risk behavior (relay genesis trusted).
   */
  acceptInvitePin(serializedPin: string): void {
    const pin = parseInvitePin(serializedPin);
    this.joinPins.set(pin.conversationId, pin);
  }

  /**
   * Dual-write (Phase A.2), same order as {@link invite}: relay REST first
   * (still the enforcement source of truth this pass — e2e removal tests
   * depend on it), then author + broadcast the matching op-log op. NOTE: the
   * relay's op-send fan-out gates each recipient by `isActiveMember`, so once
   * the REST call has revoked `userId` the relay correctly refuses to fan the
   * removal op out to the removed member — the removed member does NOT
   * converge on their own removal, by design. That is fine: removal is
   * enforced by RECEIVER-side rejection (Phase B), not by the removed member
   * self-converging. REMAINING members stay active and receive the op with no
   * ordering dependency (see the A-1 test, which asserts a remaining member's
   * convergence for exactly this reason).
   */
  async removeMember(conversationId: string, userId: string): Promise<void> {
    await this.transport.removeMember(this.tokenValue, conversationId, userId);
    await this.authorMembershipOp(conversationId, () =>
      this.membershipService!.removeMember(this.tokenValue, conversationId, userId),
    );
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
      cached = { members: new Map(), aiMode: resp.aiMode, membershipOps: [] };
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

    // Late-join genesis backfill: if we are (now) a member of this conversation
    // but hold NO local op-chain for it, we joined mid-conversation and missed
    // the genesis->tail op drain that only fires on WS connect / an explicit
    // subscribe (a lone live invite op arrives against our empty chain, hits
    // `appendMembershipOp`'s dense-seq guard as a forward gap, and is dropped).
    // Trigger the relay's manual resync ONCE and wait, bounded, for the chain
    // to populate — so the fail-closed membership gate has a chain to authorize
    // senders against before any post-join message is gate-checked. Existing
    // members (chain already present) never enter this branch, so healthy
    // traffic pays nothing.
    //
    // TRUST CAVEATS (honest scope — see SECURITY.md "Membership op-log & late-join"):
    //   1. The genesis chain served here is whatever the RELAY drains us. If an
    //      out-of-band {@link InvitePin} was seeded for this conversation
    //      ({@link acceptInvitePin}), `membershipLogFor` rebuilds it via
    //      `MembershipLog.forJoiner` and a forged/truncated genesis is REJECTED
    //      (design §4 TOFU). With NO seeded pin, relay-served genesis is TRUSTED
    //      (accepted-risk legacy path) — the pin is out-of-band precisely so the
    //      relay cannot forge both genesis and pin.
    //   2. A message sent to us in the narrow window between our REST-invite and
    //      this catch-up completing is gate-rejected + dropped (best-effort
    //      late-join delivery), NOT queued for replay.
    await this.awaitChainReady(conversationId);

    // Phase C — op-log is the membership AUTHORITY. The relay round-trip above is the device/aiMode
    // DIRECTORY (fan-out needs deviceIds the fold doesn't carry; aiMode is relay-single-writer), but the
    // authoritative *member set* is the local op-log fold. Gate the roster: a userId the relay still lists
    // but the fold does NOT contain has been removed via the op-log (possibly with the relay write lagging
    // or suppressed) and MUST NOT appear in the roster — which also drops it from fan-out (sendRaw builds
    // targets from this return value).
    //
    // Fail-closed (plans/005): when we hold NO trusted fold for this conversation
    // (corrupt/unverifiable chain, or a seeded InvitePin the persisted chain no longer matches —
    // `membershipLogFor` returns undefined for either), do NOT fall through to the raw relay roster.
    // Returning relay-sourced members here would trust membership the receive gate (`enforceInbound`)
    // has already rejected fail-closed — the two surfaces must agree. Emit no members instead. aiMode
    // was already synced above off the relay directory and is unaffected.
    const authoritative = this.membershipLogFor(conversationId)?.members(); // Set<string> | undefined
    if (authoritative === undefined) return [];

    const members: Member[] = [];
    for (const m of raw) {
      if (!authoritative.has(m.userId)) continue; // op-log authority: exclude fold-removed members
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

    // Phase B: stamp this sender's CURRENT receiver-side membership head
    // (@signalai/membership `MembershipLog.head()`, byte-identical to
    // `MembershipHeadSchema`) into the plaintext, if one exists yet. This is
    // the RECEIVER log every member holds (`membershipLogFor`), NOT
    // `membershipService.headFor` — the author-only service throws for any
    // non-authority sender (FACT 1). Stamping the current head on every
    // (re)send is intentional: the head may have advanced between sends. No
    // head yet (`membershipLogFor` -> undefined) -> leave `membershipHead`
    // absent; a receiver fail-closed-rejects an absent head (Task 2), which
    // is the correct posture rather than fabricating one.
    const head = this.membershipLogFor(conversationId)?.head();
    if (head) plaintext.membershipHead = { seq: head.seq, headHash: head.headHash };

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
   * Decrypts, gates, dedupes, and dispatches a single incoming Envelope — the
   * same path the WS `deliver` handler drives. Public so callers/tests can
   * feed it a hand-constructed Envelope directly (e.g. to prove
   * sender-authenticity: `decryptEnvelope` picks the session from
   * `envelope.senderUserId`, so a forged sender field decrypts against the
   * wrong/no session and throws — this method catches that and drops the
   * message silently, never invoking `onMessage` for an unverified sender).
   * Phase B additionally runs the membership `enforceInbound` gate after
   * decrypt+parse, fail-closed — see the inline comment below.
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

    // Phase B receiver-side gate (design §6), fail-closed. Runs AFTER decrypt
    // (:756 above) and AFTER parse (immediately above), using
    // `envelope.senderUserId` — safe to trust here ONLY because it already
    // survived `decryptEnvelope`'s session lookup (FACT 2, see the comment at
    // the top of this method). Authorizes at THIS receiver's own current
    // head, never the sender-cited head (closes C3 replay). `accepted: false`
    // -> DROP: never dispatch to `onMessage`, never add to `seenMsgIds`; ACK
    // so the relay stops redelivering a message that's rejected for good
    // (e.g. from a genuinely-removed-but-still-relay-active sender), then
    // return. No network catch-up transport exists yet in Phase B, so a
    // receiver that is behind the cited head has no way to fetch the fuller
    // chain and will reject-and-ack rather than accept post-catch-up — a
    // known Phase B liveness limitation (see report).
    let log = this.membershipLogFor(envelope.conversationId);
    // Late-join self-heal (adopt-on-first-message, site B — complements the
    // listMembers backfill at site A): if we hold NO chain for this conversation
    // yet, the relay still delivered this envelope to us — which means it
    // considers us an active member — so we joined mid-conversation and missed
    // the genesis->tail drain. Give ourselves ONE guarded chance to backfill via
    // the relay's manual resync BEFORE the fail-closed gate decides, so the FIRST
    // inbound message can populate the chain and trigger adoption instead of
    // being dropped. Site A (`listMembers`) is structurally unreachable for a
    // consumer that adopts a conversation inside its `onMessage` handler and thus
    // never calls `listMembers` before this first message.
    // DoS-safe: `opCatchupAttempted` (SHARED with the listMembers backfill — not a
    // second set) bounds this to a single subscribe + bounded await per
    // conversation per session. Deadlock-free: op-deliver frames apply via
    // `handleIncomingOp` OFF the `inbox` mutex, so they land while this awaits.
    // Does NOT weaken the gate: `enforceInbound` below still runs on the fetched
    // chain, so a removed/foreign/absent-head sender is still rejected — only the
    // "no chain at all" case gets a fetch-then-decide instead of an auto-reject.
    if (log === undefined) {
      log = await this.awaitChainReady(envelope.conversationId);
    }
    const verdict = log
      ? enforceInbound(log, envelope.senderUserId, message.membershipHead, () =>
          this.membershipLogFor(envelope.conversationId)?.chain(),
        )
      : { accepted: false, reason: "receiver holds no membership chain for this conversation" };
    if (!verdict.accepted) {
      console.debug(
        `membership gate: dropped msg in ${envelope.conversationId} from ${envelope.senderUserId}: ${verdict.reason}`,
      );
      this.safeAck(envelope.conversationId, envelope.seq); // ack so the relay stops redelivering; DROP (never dispatch).
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
