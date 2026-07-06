import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { buildApp, createPrismaClient } from "@signalai/node";
import {
  SignalAiClient,
  SqliteAgentStore,
  type IncomingMessage,
  type SystemEvent,
} from "@signalai/client-sdk";
import { SignalAgent, loadAgentConfig, type AgentConfig } from "../src/index.js";
import { MockLlmClient } from "../src/llm.js";
import type { KnowledgeSource } from "../src/knowledge.js";

/**
 * Test harness for `@signalai/agent`. Boots a REAL relay (ephemeral port, real
 * HTTP + WebSocket, real Postgres) exactly like the client-sdk e2e suite,
 * because the agent is just a long-running {@link SignalAiClient} and there is
 * no in-process short-circuit for the transport. Humans in these tests are
 * plain `SignalAiClient`s; the AI member is a {@link SignalAgent} wired to a
 * {@link MockLlmClient} so no network/keys are ever touched.
 */
export const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/signalai";
export const INVITE_CODE = "LETMEIN";

export interface RelayHarness {
  app: FastifyInstance;
  prisma: PrismaClient;
  relayUrl: string;
}

export async function startRelay(): Promise<RelayHarness> {
  const prisma = createPrismaClient(DATABASE_URL);
  const app = buildApp({ port: 0, databaseUrl: DATABASE_URL, inviteCodes: [INVITE_CODE], nodeEnv: "test" }, prisma);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  return { app, prisma, relayUrl: `http://127.0.0.1:${port}` };
}

export async function stopRelay(harness: RelayHarness): Promise<void> {
  await harness.app.close();
  await harness.prisma.$disconnect();
}

export async function resetDb(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE users, devices, signed_prekeys, kyber_prekeys, one_time_prekeys, conversations, memberships, envelopes RESTART IDENTITY CASCADE`,
  );
}

let usernameSeq = 0;
/** A username unique across the whole test run (relay usernames are globally unique). */
export function uniqueUsername(prefix: string): string {
  usernameSeq += 1;
  return `${prefix}-${Date.now()}-${usernameSeq}`;
}

/** Signs up a plain human client through the same public API the agent uses. */
export async function signupHuman(relayUrl: string, username: string): Promise<SignalAiClient> {
  return SignalAiClient.signup({ relayUrl, inviteCode: INVITE_CODE, username });
}

/** Accumulates every message a client's `onMessage` receives, preserving any handler already installed. */
export function collectMessages(client: SignalAiClient): IncomingMessage[] {
  const messages: IncomingMessage[] = [];
  const prev = client.onMessage;
  client.onMessage = (m) => {
    messages.push(m);
    prev?.(m);
  };
  return messages;
}

/** Accumulates every system event a client's `onSystemEvent` receives, preserving any handler already installed. */
export function collectEvents(client: SignalAiClient): SystemEvent[] {
  const events: SystemEvent[] = [];
  const prev = client.onSystemEvent;
  client.onSystemEvent = (e) => {
    events.push(e);
    prev?.(e);
  };
  return events;
}

/** Deterministic polling barrier (no arbitrary sleeps) for async delivery/reply assertions. */
export async function waitUntil(predicate: () => boolean, timeoutMs = 8000, intervalMs = 20): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function relayWsUrl(relayUrl: string): string {
  return relayUrl.replace(/^http/, "ws") + "/ws";
}

// --- agent-specific helpers -------------------------------------------------

const tmpRoots: string[] = [];

/** A throwaway sqlite path under a fresh temp dir; the dir is removed by {@link cleanupTmpDbs}. */
export function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "signalai-agent-"));
  tmpRoots.push(dir);
  return join(dir, "agent-state.sqlite");
}

/** Removes every temp sqlite dir created during the run (call in `afterAll`). */
export function cleanupTmpDbs(): void {
  for (const dir of tmpRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Builds an {@link AgentConfig} off `loadAgentConfig` defaults, then overrides
 * the fields a test cares about (relayUrl, a unique username, the invite code,
 * a temp db path, and any mode-engine knobs like `activeCapN`).
 */
export function makeAgentConfig(relayUrl: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    ...loadAgentConfig({}),
    relayUrl,
    username: uniqueUsername("ai"),
    inviteCode: INVITE_CODE,
    dbPath: tmpDbPath(),
    ...overrides,
  };
}

export interface BootedAgent {
  agent: SignalAgent;
  llm: MockLlmClient;
  config: AgentConfig;
  store: SqliteAgentStore;
}

/**
 * Opens a store, wires a {@link MockLlmClient}, creates and boots a
 * {@link SignalAgent}. Pass an existing `config` (same `dbPath`) to exercise
 * the resume/restart path; otherwise a fresh config is minted.
 */
export async function bootAgent(
  relayUrl: string,
  opts: {
    config?: AgentConfig;
    llm?: MockLlmClient;
    configOverrides?: Partial<AgentConfig>;
    /** Optional knowledge source (vault-aware augmentation); omitted => unchanged legacy behavior. */
    knowledge?: KnowledgeSource;
  } = {},
): Promise<BootedAgent> {
  const config = opts.config ?? makeAgentConfig(relayUrl, opts.configOverrides);
  const store = await SqliteAgentStore.open(config.dbPath, config.dbKey ? { encryptionKey: config.dbKey } : {});
  const llm = opts.llm ?? new MockLlmClient();
  const agent = await SignalAgent.create({ config, store, llm, knowledge: opts.knowledge });
  await agent.boot();
  return { agent, llm, config, store };
}
