import type { PreKeyBundle } from "@signalapp/libsignal-client";
import {
  Identity,
  InMemoryStores,
  PrekeyManager,
  SessionManager,
  GroupFanout,
  type DeviceAddress,
  type ProvisionedPreKeys,
} from "../src/index.js";

/** A fully-provisioned test party: identity, stores, session/fan-out helpers, and a fresh-bundle factory. */
export interface TestParty {
  address: DeviceAddress;
  identity: Identity;
  stores: InMemoryStores;
  sessionManager: SessionManager;
  fanout: GroupFanout;
  provisioned: ProvisionedPreKeys;
  /** Builds a PreKeyBundle for this party, consuming a never-before-used one-time prekey each call. */
  nextBundle(): PreKeyBundle;
}

let nextIdBase = 1;

/**
 * Creates a party with a real identity, a full set of provisioned prekeys
 * (20 one-time prekeys), and session/fan-out helpers wired to its own
 * address and stores. Each call to `nextBundle()` hands out a fresh
 * one-time prekey, mirroring how a real relay allocates one per bundle
 * fetch so multiple peers can each establish a session with this party
 * without exhausting a shared prekey.
 */
export async function createParty(userId: string, deviceId = 1): Promise<TestParty> {
  const identity = Identity.generate();
  const stores = InMemoryStores.create(identity.keyPair.privateKey, identity.registrationId);
  const idBase = nextIdBase++;

  const provisioned = await PrekeyManager.provision(stores, identity.keyPair.privateKey, {
    signedPreKeyId: idBase,
    kyberPreKeyId: idBase,
    oneTimePreKeyStartId: idBase * 1000,
    oneTimePreKeyCount: 20,
  });

  const address: DeviceAddress = { userId, deviceId };
  const sessionManager = new SessionManager(address, stores);
  const fanout = new GroupFanout(sessionManager);

  let oneTimePreKeyIndex = 0;
  function nextBundle(): PreKeyBundle {
    const oneTimePreKey = provisioned.oneTimePreKeys[oneTimePreKeyIndex++];
    return PrekeyManager.buildBundle({
      registrationId: identity.registrationId,
      deviceId,
      identityKey: identity.keyPair.publicKey,
      signedPreKey: provisioned.signedPreKey,
      kyberPreKey: provisioned.kyberPreKey,
      oneTimePreKey,
    });
  }

  return { address, identity, stores, sessionManager, fanout, provisioned, nextBundle };
}

/** Encodes a string as UTF-8 bytes for use as Signal-protocol plaintext. */
export function textToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Decodes UTF-8 bytes back into a string. */
export function bytesToText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
