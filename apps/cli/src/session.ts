import { mkdirSync } from "node:fs";
import {
  SignalAiClient,
  SqliteAgentStore,
  InMemoryClientStores,
  type PersistedClientState,
  type SerializedClientStores,
} from "@signalai/client-sdk";
import { accountDbPath, trustDbPath, type CliConfig } from "./config.js";
import { CliTrustStore } from "./trust-store.js";

/**
 * A live account: the connected SDK client plus its two durable stores. The CLI
 * reuses the phase-5 {@link SqliteAgentStore} for the SDK state (identity /
 * ratchet / resume scalars) exactly as the agent does — no new SDK store
 * interface — and adds a sibling {@link CliTrustStore} for the trust surface.
 */
export interface CliSession {
  client: SignalAiClient;
  agentStore: SqliteAgentStore;
  trustStore: CliTrustStore;
  /** Snapshots the full SDK account state to the durable store (call after every state mutation). */
  persist(): void;
  /** Disconnects and flushes+closes both stores. */
  close(): Promise<void>;
}

/** Serializes the SDK stores, narrowing to the concrete in-memory impl (mirrors the agent; no cast). */
function serializeStores(client: SignalAiClient): SerializedClientStores {
  const stores = client.stores;
  if (!(stores instanceof InMemoryClientStores)) {
    throw new Error("CliSession: expected InMemoryClientStores to persist client state");
  }
  return stores.toJSON();
}

/** Builds the exact {@link PersistedClientState} blob `SignalAiClient.resume` consumes. */
function currentState(client: SignalAiClient): PersistedClientState {
  const id = client.serializedIdentity;
  return {
    token: client.token,
    userId: client.userId,
    username: client.username,
    deviceId: client.deviceId,
    nextOneTimePreKeyId: client.nextPreKeyId,
    serializedIdentity: {
      identityKeyPair: Buffer.from(id.identityKeyPair).toString("base64"),
      registrationId: id.registrationId,
    },
    serializedStores: serializeStores(client),
  };
}

function wrap(client: SignalAiClient, agentStore: SqliteAgentStore, trustStore: CliTrustStore): CliSession {
  const persist = (): void => agentStore.save(currentState(client));
  return {
    client,
    agentStore,
    trustStore,
    persist,
    close: async () => {
      persist();
      client.disconnect();
      agentStore.close();
      trustStore.close();
      await Promise.resolve();
    },
  };
}

async function openStores(config: CliConfig, username: string): Promise<{
  agentStore: SqliteAgentStore;
  trustStore: CliTrustStore;
}> {
  mkdirSync(config.stateDir, { recursive: true });
  const keyOpt = config.dbKey ? { encryptionKey: config.dbKey } : {};
  const agentStore = await SqliteAgentStore.open(accountDbPath(config, username), keyOpt);
  const trustStore = await CliTrustStore.open(trustDbPath(config, username), keyOpt);
  return { agentStore, trustStore };
}

/**
 * Creates a brand-new relay account (`signalai signup`): signs up, immediately
 * persists the durable state, and returns a connected {@link CliSession}.
 */
export async function signupSession(params: {
  config: CliConfig;
  username: string;
  inviteCode: string;
}): Promise<CliSession> {
  const { agentStore, trustStore } = await openStores(params.config, params.username);
  const client = await SignalAiClient.signup({
    relayUrl: params.config.relayUrl,
    inviteCode: params.inviteCode,
    username: params.username,
    // Human CLI: peers are resolved by username via resolveUser so the trust
    // surface stays anchored to a name — never auto-resolve opaque userIds.
    autoResolveMembersById: false,
  });
  const session = wrap(client, agentStore, trustStore);
  session.persist();
  return session;
}

/**
 * Resumes an EXISTING account (`signalai login`) from persisted state without
 * re-provisioning or rotating any keys (publishes nothing). Throws if the
 * account was never signed up on this machine.
 */
export async function loginSession(params: { config: CliConfig; username: string }): Promise<CliSession> {
  const { agentStore, trustStore } = await openStores(params.config, params.username);
  const persisted = agentStore.load();
  if (!persisted) {
    agentStore.close();
    trustStore.close();
    throw new Error(`login: no persisted account for "${params.username}" under ${params.config.stateDir} — run "signalai signup" first`);
  }
  const client = await SignalAiClient.resume({
    relayUrl: params.config.relayUrl,
    token: persisted.token,
    userId: persisted.userId,
    username: persisted.username,
    deviceId: persisted.deviceId,
    serializedIdentity: {
      identityKeyPair: Buffer.from(persisted.serializedIdentity.identityKeyPair, "base64"),
      registrationId: persisted.serializedIdentity.registrationId,
    },
    serializedStores: persisted.serializedStores,
    nextOneTimePreKeyId: persisted.nextOneTimePreKeyId,
    autoResolveMembersById: false,
  });
  return wrap(client, agentStore, trustStore);
}
