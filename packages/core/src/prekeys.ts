import {
  PrivateKey,
  PublicKey,
  PreKeyRecord,
  SignedPreKeyRecord,
  KyberPreKeyRecord,
  KEMKeyPair,
  PreKeyBundle,
} from "@signalapp/libsignal-client";
import type { CoreStores } from "./stores.js";

/** The prekey material generated and persisted by {@link PrekeyManager.provision}. */
export interface ProvisionedPreKeys {
  signedPreKey: SignedPreKeyRecord;
  kyberPreKey: KyberPreKeyRecord;
  oneTimePreKeys: PreKeyRecord[];
}

/** Caller-chosen ids for a batch of generated prekeys. Ids are not secret; they only need to be unique per device. */
export interface ProvisionOptions {
  signedPreKeyId: number;
  kyberPreKeyId: number;
  oneTimePreKeyStartId?: number;
  oneTimePreKeyCount?: number;
  timestamp?: number;
}

/** The key material {@link PrekeyManager.buildBundle} assembles into a publishable `PreKeyBundle`. */
export interface BuildBundleParams {
  registrationId: number;
  deviceId: number;
  identityKey: PublicKey;
  signedPreKey: SignedPreKeyRecord;
  kyberPreKey: KyberPreKeyRecord;
  oneTimePreKey?: PreKeyRecord;
}

/**
 * Generates and persists the prekey material a device publishes so peers
 * can start a session with it via X3DH (EC prekeys) + PQXDH (kyber
 * prekey). Every generated key is produced directly by libsignal-client;
 * the only non-cryptographic values here are the caller-chosen numeric ids.
 */
export class PrekeyManager {
  /** Generates a signed EC prekey, signed with the device's identity private key. */
  static generateSignedPreKey(identityPrivateKey: PrivateKey, id: number, timestamp = Date.now()): SignedPreKeyRecord {
    const keyPair = PrivateKey.generate();
    const publicKey = keyPair.getPublicKey();
    const signature = identityPrivateKey.sign(publicKey.serialize());
    return SignedPreKeyRecord.new(id, timestamp, publicKey, keyPair, signature);
  }

  /** Generates a signed kyber (PQXDH) prekey, signed with the device's identity private key. */
  static generateKyberPreKey(identityPrivateKey: PrivateKey, id: number, timestamp = Date.now()): KyberPreKeyRecord {
    const kemKeyPair = KEMKeyPair.generate();
    const signature = identityPrivateKey.sign(kemKeyPair.getPublicKey().serialize());
    return KyberPreKeyRecord.new(id, timestamp, kemKeyPair, signature);
  }

  /** Generates `count` one-time EC prekeys with sequential ids starting at `startId`. */
  static generateOneTimePreKeys(startId: number, count: number): PreKeyRecord[] {
    const records: PreKeyRecord[] = [];
    for (let i = 0; i < count; i++) {
      const keyPair = PrivateKey.generate();
      records.push(PreKeyRecord.new(startId + i, keyPair.getPublicKey(), keyPair));
    }
    return records;
  }

  /**
   * Generates a full set of prekeys (signed EC, signed kyber, and a batch
   * of one-time EC prekeys) and saves them into `stores` so they're ready
   * for `signalDecryptPreKey` to consume when a peer's first message
   * arrives.
   */
  static async provision(
    stores: CoreStores,
    identityPrivateKey: PrivateKey,
    opts: ProvisionOptions,
  ): Promise<ProvisionedPreKeys> {
    const signedPreKey = this.generateSignedPreKey(identityPrivateKey, opts.signedPreKeyId, opts.timestamp);
    const kyberPreKey = this.generateKyberPreKey(identityPrivateKey, opts.kyberPreKeyId, opts.timestamp);
    const oneTimePreKeys = this.generateOneTimePreKeys(opts.oneTimePreKeyStartId ?? 1, opts.oneTimePreKeyCount ?? 1);

    await stores.signedPreKey.saveSignedPreKey(opts.signedPreKeyId, signedPreKey);
    await stores.kyberPreKey.saveKyberPreKey(opts.kyberPreKeyId, kyberPreKey);
    for (const oneTimePreKey of oneTimePreKeys) {
      await stores.preKey.savePreKey(oneTimePreKey.id(), oneTimePreKey);
    }

    return { signedPreKey, kyberPreKey, oneTimePreKeys };
  }

  /** Assembles the `PreKeyBundle` a peer needs to start a session with this device. */
  static buildBundle(params: BuildBundleParams): PreKeyBundle {
    const oneTimePreKey = params.oneTimePreKey;
    return PreKeyBundle.new(
      params.registrationId,
      params.deviceId,
      oneTimePreKey ? oneTimePreKey.id() : null,
      oneTimePreKey ? oneTimePreKey.publicKey() : null,
      params.signedPreKey.id(),
      params.signedPreKey.publicKey(),
      params.signedPreKey.signature(),
      params.identityKey,
      params.kyberPreKey.id(),
      params.kyberPreKey.publicKey(),
      params.kyberPreKey.signature(),
    );
  }
}
