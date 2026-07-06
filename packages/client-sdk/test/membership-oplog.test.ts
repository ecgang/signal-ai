import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fromBase64 } from "@signalai/core";
import { MembershipLog, decodeOp, type OpLogMembershipService } from "@signalai/membership";
import { SignalAiClient, InMemoryClientStores } from "../src/index.js";
import { type RelayHarness, startRelay, stopRelay, resetDb, uniqueUsername, signupClient, waitUntil } from "./helpers.js";

/**
 * Phase A.2 falsifiable floor (§A of the phase spec): the client-sdk op-log
 * wiring — author-side broadcast + receiver-side accumulate/ingest/persist —
 * proven against the REAL relay + Postgres + core crypto (same harness as
 * e2e.test.ts). The gate (`enforceInbound`) is NOT exercised here — that's
 * Phase B; this pass only proves the chain PROPAGATES and PERSISTS
 * identically across peers.
 */

let harness: RelayHarness;

beforeAll(async () => {
  harness = await startRelay();
});
afterAll(async () => {
  await stopRelay(harness);
});
beforeEach(async () => {
  await resetDb(harness.prisma);
});

function relayUrl(): string {
  return harness.relayUrl;
}

/** Reaches past `SignalAiClient`'s private field to the creator's authoring service — the AUTHORITATIVE ground truth this test compares the receiver's persisted chain against (spec: "client-2's persisted chain head EQUALS client-1's `service.headFor(convId)`"). */
function authorServiceOf(client: SignalAiClient): OpLogMembershipService {
  return (client as unknown as { membershipService: OpLogMembershipService }).membershipService;
}

describe("membership op-log: client-sdk propagation + persistence (Phase A.2)", () => {
  it("A-1: a REMAINING member converges on the same chain head after a remove op propagates", async () => {
    const alice = await signupClient(relayUrl(), uniqueUsername("alice"));
    const bob = await signupClient(relayUrl(), uniqueUsername("bob"));
    const carol = await signupClient(relayUrl(), uniqueUsername("carol"));

    await alice.resolveUser(bob.username);
    await alice.resolveUser(carol.username);
    await carol.resolveUser(alice.username);
    await carol.resolveUser(bob.username);

    // alice is the creator/authority: her OpLogMembershipService authors genesis
    // (alice+bob+carol) + the remove op. carol is a REMAINING member.
    const convId = await alice.createConversation([bob.userId, carol.userId]);
    await bob.listMembers(convId);
    await carol.listMembers(convId);

    await alice.removeMember(convId, bob.userId);

    // We assert CAROL's convergence, NOT bob's. bob is the removed member: under
    // dual-write the relay correctly refuses to fan bob's own removal op to him
    // (he is no longer isActiveMember), so he cannot converge — enforcement is
    // receiver-side rejection (Phase B), not self-convergence. carol stays active
    // throughout, so she receives genesis (via listMembers drain) + the remove op
    // (via live fan-out) with NO ordering dependency between the relay's REST
    // removal and the op broadcast — the race-free property this test locks.
    await waitUntil(() => (carol.membershipLogFor(convId)?.head().seq ?? -1) >= 1, 10_000);

    const authorHead = authorServiceOf(alice).headFor(convId);
    const carolHead = carol.membershipLogFor(convId)!.head();

    expect(carolHead.seq).toBe(authorHead.seq);
    expect(carolHead.headHash).toBe(authorHead.headHash);

    // alice's own receiver-side view (synced author-side after every op, since
    // the relay fan-out excludes the sender) also matches — same chain, same head.
    const aliceOwnHead = alice.membershipLogFor(convId)!.head();
    expect(aliceOwnHead.seq).toBe(authorHead.seq);
    expect(aliceOwnHead.headHash).toBe(authorHead.headHash);

    alice.disconnect();
    bob.disconnect();
    carol.disconnect();
  }, 30_000);

  it("A-3: cold-load round-trip (serialize -> deserialize ClientStores -> MembershipLog.open) reproduces the same head", async () => {
    const alice = await signupClient(relayUrl(), uniqueUsername("alice"));
    const bob = await signupClient(relayUrl(), uniqueUsername("bob"));
    const carol = await signupClient(relayUrl(), uniqueUsername("carol"));

    await alice.resolveUser(bob.username);
    await alice.resolveUser(carol.username);
    await carol.resolveUser(alice.username);
    await carol.resolveUser(bob.username);

    const convId = await alice.createConversation([bob.userId, carol.userId]);
    await bob.listMembers(convId);
    await carol.listMembers(convId);
    await alice.removeMember(convId, bob.userId);

    // Cold-load a REMAINING member (carol): her persisted chain is the full
    // genesis + remove (head seq 1), so the round-trip exercises a multi-op
    // chain rather than a lone genesis. (The removed member does not converge —
    // see A-1 — so bob would only ever have genesis to reload.)
    await waitUntil(() => (carol.membershipLogFor(convId)?.head().seq ?? -1) >= 1, 10_000);
    const headBefore = carol.membershipLogFor(convId)!.head();

    // Serialize -> deserialize carol's ENTIRE ClientStores, then rebuild the
    // MembershipLog purely from the rehydrated base64 chain (no in-memory state reused).
    const snapshot = carol.stores.toJSON();
    const rehydrated = InMemoryClientStores.fromJSON(snapshot);
    const rehydratedConv = rehydrated.conversations.get(convId);
    expect(rehydratedConv).toBeDefined();
    expect(rehydratedConv!.membershipOps.length).toBeGreaterThan(1);

    const chain = rehydratedConv!.membershipOps.map((encoded) => decodeOp(fromBase64(encoded)));
    const reopened = MembershipLog.open(chain);

    expect(reopened.head().seq).toBe(headBefore.seq);
    expect(reopened.head().headHash).toBe(headBefore.headHash);
    // The raw serialized snapshot itself round-trips byte-for-byte (matches the phase5a store-serialization pattern).
    expect(JSON.stringify(rehydrated.toJSON())).toBe(JSON.stringify(snapshot));

    alice.disconnect();
    bob.disconnect();
    carol.disconnect();
  }, 30_000);
});
