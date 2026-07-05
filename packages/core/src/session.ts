import {
  ProtocolAddress,
  PreKeyBundle,
  SignalMessage,
  PreKeySignalMessage,
  CiphertextMessage,
  CiphertextMessageType,
  processPreKeyBundle,
  signalEncrypt,
  signalDecrypt,
  signalDecryptPreKey,
} from "@signalapp/libsignal-client";
import type { CoreStores } from "./stores.js";

/** Addresses a specific device belonging to a user — the unit every session/encrypt/decrypt call targets. */
export interface DeviceAddress {
  userId: string;
  deviceId: number;
}

/** Converts a {@link DeviceAddress} into the libsignal `ProtocolAddress` the native API expects. */
export function toProtocolAddress(address: DeviceAddress): ProtocolAddress {
  return ProtocolAddress.new(address.userId, address.deviceId);
}

/**
 * Drives libsignal-client's free-function session API
 * (`processPreKeyBundle` / `signalEncrypt` / `signalDecrypt` /
 * `signalDecryptPreKey`) on behalf of one local party's identity + stores.
 *
 * `localAddress` is threaded into every call because this version of
 * libsignal-client's API requires it explicitly (unlike older
 * SessionCipher-based APIs, which inferred "local" from the store instance
 * alone).
 */
export class SessionManager {
  constructor(
    private readonly localAddress: DeviceAddress,
    private readonly stores: CoreStores,
  ) {}

  /**
   * Serializes every store-mutating libsignal call on this manager. Each of
   * `signalEncrypt` / `signalDecrypt` / `signalDecryptPreKey` /
   * `processPreKeyBundle` does an async read-modify-write of the pairwise
   * session record (getSession → ratchet step → saveSession). A client sends
   * (encrypt) on its own call path while its inbox chain decrypts
   * concurrently, so without this lock an encrypt and a decrypt for the SAME
   * peer can interleave across their `await`s, lose one side's ratchet
   * advance, and desync the session — after which the next decrypt throws and
   * (because the client drops undecryptable envelopes) the message is silently
   * lost. This manifests only under a group's simultaneous cross-peer traffic,
   * which is exactly why 1:1 flows never hit it. One mutex per local identity
   * makes each operation atomic w.r.t. the shared stores; no libsignal call
   * re-enters SessionManager, so it cannot deadlock.
   */
  private storeTail: Promise<unknown> = Promise.resolve();

  private runExclusive<T>(op: () => Promise<T>): Promise<T> {
    const result = this.storeTail.then(op);
    // Keep the chain alive whether this op resolves or rejects, but hand the
    // real result (or error) back to this caller.
    this.storeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private get localProtocolAddress(): ProtocolAddress {
    return toProtocolAddress(this.localAddress);
  }

  /**
   * Establishes (or re-establishes) an outbound session with `remote` from
   * their published `PreKeyBundle`. Only the party initiating contact needs
   * to call this — the receiving side's session is created lazily the
   * first time it decrypts an incoming PreKey message via {@link decrypt}.
   */
  async establishSession(remote: DeviceAddress, bundle: PreKeyBundle): Promise<void> {
    await this.runExclusive(() =>
      processPreKeyBundle(
        bundle,
        toProtocolAddress(remote),
        this.localProtocolAddress,
        this.stores.session,
        this.stores.identity,
      ),
    );
  }

  /** Encrypts `plaintext` for `remote` using the existing (or just-established) session between the two parties. */
  async encrypt(remote: DeviceAddress, plaintext: Uint8Array): Promise<CiphertextMessage> {
    return this.runExclusive(() =>
      signalEncrypt(
        plaintext,
        toProtocolAddress(remote),
        this.localProtocolAddress,
        this.stores.session,
        this.stores.identity,
      ),
    );
  }

  /**
   * Decrypts a ciphertext received from `remote`. `type` must be the
   * `CiphertextMessageType` value the sender reported (Whisper or PreKey)
   * so the right message deserializer/decrypt path is used; anything else
   * is rejected.
   */
  async decrypt(remote: DeviceAddress, type: number, ciphertext: Uint8Array): Promise<Uint8Array> {
    return this.runExclusive(() => {
      const remoteAddress = toProtocolAddress(remote);

      if (type === CiphertextMessageType.PreKey) {
        const message = PreKeySignalMessage.deserialize(ciphertext);
        return signalDecryptPreKey(
          message,
          remoteAddress,
          this.localProtocolAddress,
          this.stores.session,
          this.stores.identity,
          this.stores.preKey,
          this.stores.signedPreKey,
          this.stores.kyberPreKey,
        );
      }

      if (type === CiphertextMessageType.Whisper) {
        const message = SignalMessage.deserialize(ciphertext);
        return signalDecrypt(
          message,
          remoteAddress,
          this.localProtocolAddress,
          this.stores.session,
          this.stores.identity,
        );
      }

      throw new Error(`SessionManager.decrypt: unsupported ciphertext type ${type}`);
    });
  }
}
