import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { buildApp, createPrismaClient } from "@signalai/relay";
import { SignalAiClient, type IncomingMessage, type SystemEvent } from "../src/index.js";

/**
 * E2E test harness: boots a REAL relay (listening on an ephemeral port, not
 * `fastify.inject()`) against the repo's docker-compose Postgres, because
 * `@signalai/client-sdk` speaks real HTTP (`fetch`) + real WebSocket (`ws`) —
 * there is no in-process short-circuit for either.
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
/** A username that's unique across the whole test run (relay usernames are globally unique). */
export function uniqueUsername(prefix: string): string {
  usernameSeq += 1;
  return `${prefix}-${Date.now()}-${usernameSeq}`;
}

export async function signupClient(
  relayUrl: string,
  username: string,
  opts: { initialOneTimePreKeyCount?: number } = {},
): Promise<SignalAiClient> {
  return SignalAiClient.signup({
    relayUrl,
    inviteCode: INVITE_CODE,
    username,
    initialOneTimePreKeyCount: opts.initialOneTimePreKeyCount,
  });
}

/** Wires an array that accumulates every message a client's `onMessage` handler receives. */
export function collectMessages(client: SignalAiClient): IncomingMessage[] {
  const messages: IncomingMessage[] = [];
  client.onMessage = (m) => messages.push(m);
  return messages;
}

/** Wires an array that accumulates every system event a client's `onSystemEvent` handler receives. */
export function collectEvents(client: SignalAiClient): SystemEvent[] {
  const events: SystemEvent[] = [];
  client.onSystemEvent = (e) => events.push(e);
  return events;
}

/** Deterministic polling barrier (no arbitrary sleeps) for async delivery/ack assertions. */
export async function waitUntil(predicate: () => boolean, timeoutMs = 5000, intervalMs = 20): Promise<void> {
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
