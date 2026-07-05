import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SignalAiClient } from "../src/index.js";
import {
  type RelayHarness,
  startRelay,
  stopRelay,
  resetDb,
  uniqueUsername,
  signupClient,
} from "./helpers.js";

/**
 * Phase 6A propagation proof for @signalai/client-sdk: `aiMode` now travels
 * through the relay's `GET /conversations/:id/members` response, so a peer's
 * `setAiMode` toggle becomes observable to any OTHER member the next time it
 * refreshes membership. Real relay + real Postgres, driven through the public
 * SDK API. (V-6A.1 round-trip, V-6A.3 no self-regression.)
 */

let harness: RelayHarness;
const clients: SignalAiClient[] = [];

beforeAll(async () => {
  harness = await startRelay();
});

afterAll(async () => {
  await stopRelay(harness);
});

beforeEach(async () => {
  await resetDb(harness.prisma);
});

afterEach(() => {
  for (const c of clients.splice(0)) {
    try {
      c.disconnect();
    } catch {
      /* already disconnected */
    }
  }
});

function relayUrl(): string {
  return harness.relayUrl;
}

function track(client: SignalAiClient): SignalAiClient {
  clients.push(client);
  return client;
}

describe("@signalai/client-sdk — 6A aiMode propagation", () => {
  it("V-6A.1: a peer's setAiMode is READABLE by a different client after listMembers (round-trip, not echo)", async () => {
    const a = track(await signupClient(relayUrl(), uniqueUsername("a")));
    const b = track(await signupClient(relayUrl(), uniqueUsername("b")));
    await Promise.all([a.resolveUser(b.username), b.resolveUser(a.username)]);

    // Created PASSIVE (default). B is a member and learns the id out-of-band.
    const convId = await a.createConversation([b.userId]);
    await b.listMembers(convId);
    expect(b.getAiMode(convId)).toBe(false);

    // A flips it ON. B only sees it after B pulls membership from the relay —
    // proving the mode crossed the wire, not just A's local cache.
    await a.setAiMode(convId, true);
    await b.listMembers(convId);
    expect(b.getAiMode(convId)).toBe(true);

    // A flips it back OFF; the same refresh path returns B to false.
    await a.setAiMode(convId, false);
    await b.listMembers(convId);
    expect(b.getAiMode(convId)).toBe(false);
  }, 20_000);

  it("V-6A.3: setAiMode's optimistic set is not clobbered by an immediate self listMembers (no self-regression)", async () => {
    const a = track(await signupClient(relayUrl(), uniqueUsername("a")));
    const b = track(await signupClient(relayUrl(), uniqueUsername("b")));
    await Promise.all([a.resolveUser(b.username), b.resolveUser(a.username)]);

    const convId = await a.createConversation([b.userId]);
    expect(a.getAiMode(convId)).toBe(false);

    // A sets active, then immediately re-pulls membership. The every-refresh
    // sync in listMembers reads the relay's persisted "active", so A stays true
    // (the relay PATCH is synchronous — no stale false).
    await a.setAiMode(convId, true);
    expect(a.getAiMode(convId)).toBe(true);
    await a.listMembers(convId);
    expect(a.getAiMode(convId)).toBe(true);
  }, 20_000);
});
