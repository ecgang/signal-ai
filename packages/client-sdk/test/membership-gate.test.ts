import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type OpLogMembershipService } from "@signalai/membership";
import { SignalAiClient, type IncomingMessage } from "../src/index.js";
import { type RelayHarness, startRelay, stopRelay, resetDb, uniqueUsername, signupClient, waitUntil, collectMessages } from "./helpers.js";

/**
 * Phase B falsifiable floor (§B of the phase spec): the receiver-side
 * `enforceInbound` gate, exercised end to end against the REAL relay +
 * Postgres + core crypto (same harness as e2e.test.ts / membership-oplog.test.ts).
 * Phase A already proved the op-log PROPAGATES and PERSISTS; this pass proves
 * it is actually ENFORCED on the receive path, fail-closed.
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

/** Reaches past `SignalAiClient`'s private field to the creator's authoring service (same pattern as membership-oplog.test.ts:33). */
function authorServiceOf(client: SignalAiClient): OpLogMembershipService {
  return (client as unknown as { membershipService: OpLogMembershipService }).membershipService;
}

/** The service's `removeMember(token, ...)` ignores `token` (vestigial in P2P, see service.ts) — reached the same private-field way `authorServiceOf` does, for fidelity rather than because it's load-bearing. */
function tokenOf(client: SignalAiClient): string {
  return (client as unknown as { tokenValue: string }).tokenValue;
}

/**
 * op-log-only removal (spec Task 3 phasing correction): calling the public
 * `client.removeMember` dual-writes (REST DELETE + author op), and the
 * relay's fenced sender-gate then drops the removed member's sends BEFORE
 * they ever reach a receiver — so receiver-side enforcement is never
 * exercised. To prove the RECEIVER'S gate does the rejecting, the removed
 * member must stay relay-active (the relay still forwards its sends); only
 * the op-log is told they're gone, by authoring the remove op directly
 * against the private author service and skipping the REST DELETE.
 */
async function opLogOnlyRemove(authority: SignalAiClient, conversationId: string, removedUserId: string): Promise<void> {
  await authorServiceOf(authority).removeMember(tokenOf(authority), conversationId, removedUserId);
}

describe("membership gate: receiver-side enforceInbound enforcement (Phase B)", () => {
  it("B-1: end-to-end removal — a removed-but-still-relay-active sender's message is dropped at the remaining member's receive path", async () => {
    const alice = await signupClient(relayUrl(), uniqueUsername("alice"));
    const bob = await signupClient(relayUrl(), uniqueUsername("bob"));
    const carol = await signupClient(relayUrl(), uniqueUsername("carol"));

    await alice.resolveUser(bob.username);
    await alice.resolveUser(carol.username);
    await bob.resolveUser(alice.username);
    await bob.resolveUser(carol.username); // bob sends in this test, so he needs a session with every other member
    await carol.resolveUser(alice.username);
    await carol.resolveUser(bob.username);

    const convId = await alice.createConversation([bob.userId, carol.userId]);
    await bob.listMembers(convId); // drain genesis so bob's later stamp has a head
    await carol.listMembers(convId); // drain genesis so carol's gate has a chain to authorize against

    const carolMessages = collectMessages(carol);

    // op-log-only-remove bob: relay still sees him as active (forwards his sends);
    // only the receiver's folded op-log knows he's gone -> the gate does the rejecting.
    await opLogOnlyRemove(alice, convId, bob.userId);
    await waitUntil(() => (carol.membershipLogFor(convId)?.head().seq ?? -1) >= 1, 10_000);

    await bob.send(convId, "after removal");

    // Bounded settle window: prove carol's onMessage is NEVER invoked for this send.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(carolMessages.find((m) => m.text === "after removal")).toBeUndefined();
    expect(carolMessages.length).toBe(0);

    alice.disconnect();
    bob.disconnect();
    carol.disconnect();
  }, 30_000);

  it("B-2: C3 replay — a removed sender citing his stale pre-removal head is still rejected, authorized at the receiver's OWN head", async () => {
    const alice = await signupClient(relayUrl(), uniqueUsername("alice"));
    const bob = await signupClient(relayUrl(), uniqueUsername("bob"));
    const carol = await signupClient(relayUrl(), uniqueUsername("carol"));

    await alice.resolveUser(bob.username);
    await alice.resolveUser(carol.username);
    await bob.resolveUser(alice.username);
    await bob.resolveUser(carol.username); // bob sends in this test, so he needs a session with every other member
    await carol.resolveUser(alice.username);
    await carol.resolveUser(bob.username);

    const convId = await alice.createConversation([bob.userId, carol.userId]);
    await bob.listMembers(convId);
    await carol.listMembers(convId);

    const carolMessages = collectMessages(carol);

    await opLogOnlyRemove(alice, convId, bob.userId);
    await waitUntil(() => (carol.membershipLogFor(convId)?.head().seq ?? -1) >= 1, 10_000);

    // Freeze bob's op-log at genesis (seq 0) so `sendRaw` stamps his STALE
    // pre-removal head, not his (unreceived, since the relay never forwards
    // an author's own op) up-to-date one.
    const bobConv = bob.stores.conversations.get(convId)!;
    bobConv.membershipOps.length = 1;

    await bob.send(convId, "replay with stale head");

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(carolMessages.find((m) => m.text === "replay with stale head")).toBeUndefined();
    expect(carolMessages.length).toBe(0);

    alice.disconnect();
    bob.disconnect();
    carol.disconnect();
  }, 30_000);

  it("B-3: absent-head fail-closed — a message with no membershipHead is dropped even from a current member", async () => {
    const alice = await signupClient(relayUrl(), uniqueUsername("alice"));
    const carol = await signupClient(relayUrl(), uniqueUsername("carol"));

    await alice.resolveUser(carol.username);
    await carol.resolveUser(alice.username);

    const convId = await alice.createConversation([carol.userId]);
    await alice.listMembers(convId);
    await carol.listMembers(convId);

    const carolMessages = collectMessages(carol);

    // Force alice's stamp to be ABSENT: clear her local op cache for the conv
    // so `membershipLogFor` -> undefined -> `sendRaw` omits `membershipHead`.
    alice.stores.conversations.get(convId)!.membershipOps = [];

    await alice.send(convId, "no head");

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(carolMessages.find((m) => m.text === "no head")).toBeUndefined();
    expect(carolMessages.length).toBe(0);

    alice.disconnect();
    carol.disconnect();
  }, 30_000);

  it("B-4: no-regression — healthy in-group traffic from a current, stamped member still delivers", async () => {
    const alice = await signupClient(relayUrl(), uniqueUsername("alice"));
    const carol = await signupClient(relayUrl(), uniqueUsername("carol"));

    await alice.resolveUser(carol.username);
    await carol.resolveUser(alice.username);

    const convId = await alice.createConversation([carol.userId]);
    await alice.listMembers(convId);
    await carol.listMembers(convId);

    const carolMessages: IncomingMessage[] = collectMessages(carol);

    await alice.send(convId, "hello");

    await waitUntil(() => carolMessages.some((m) => m.text === "hello"), 10_000);
    const received = carolMessages.find((m) => m.text === "hello")!;
    expect(received.senderUserId).toBe(alice.userId);

    alice.disconnect();
    carol.disconnect();
  }, 30_000);
});

describe("membership gate: out-of-band InvitePin TOFU on late-join (design §4)", () => {
  it("D-1: a CORRECT out-of-band pin accepts the matching relay-served genesis — the joiner catches up on first message and delivers a current member's send", async () => {
    const alice = await signupClient(relayUrl(), uniqueUsername("alice"));
    const carol = await signupClient(relayUrl(), uniqueUsername("carol"));

    await alice.resolveUser(carol.username);
    await carol.resolveUser(alice.username);

    const convId = await alice.createConversation([carol.userId]);
    await alice.listMembers(convId); // creator drains so it can build the pin

    // Inviter hands the joiner the pin OUT OF BAND (here: direct call, not via relay).
    const pin = alice.invitePinFor(convId);
    carol.acceptInvitePin(pin);

    const carolMessages = collectMessages(carol);

    // carol has NOT drained — her first inbound message drives the site-B
    // catch-up, which now rebuilds via forJoiner(pin). The correct pin matches
    // the relay-served genesis, so the chain adopts and the gate authorizes alice.
    await alice.send(convId, "hello pinned");

    await waitUntil(() => carolMessages.some((m) => m.text === "hello pinned"), 10_000);
    expect(carol.membershipLogFor(convId)).not.toBeUndefined();
    expect([...carol.membershipLogFor(convId)!.members()]).toContain(alice.userId);

    alice.disconnect();
    carol.disconnect();
  }, 30_000);

  it("D-2: a FORGED pin (genesis-hash mismatch) makes the joiner REJECT the very same relay-served genesis and drop the sender's message — fail-closed, proving the pin is load-bearing", async () => {
    const alice = await signupClient(relayUrl(), uniqueUsername("alice"));
    const carol = await signupClient(relayUrl(), uniqueUsername("carol"));

    await alice.resolveUser(carol.username);
    await carol.resolveUser(alice.username);

    const convId = await alice.createConversation([carol.userId]);
    await alice.listMembers(convId);

    // Same conversation, same honest relay genesis as D-1 — but the joiner seeds
    // a pin whose genesisHash is tampered (still valid hex). The out-of-band pin
    // is the trust root, so the mismatch means the relay-served genesis is NOT
    // the one the joiner was invited to → reject, not trust.
    const realPin = JSON.parse(alice.invitePinFor(convId)) as { genesisHash: string };
    const g = realPin.genesisHash;
    const forgedPin = JSON.stringify({ ...realPin, genesisHash: (g[0] === "0" ? "1" : "0") + g.slice(1) });
    carol.acceptInvitePin(forgedPin);

    const carolMessages = collectMessages(carol);

    await alice.send(convId, "should be rejected");

    // Exceed the bounded site-B catch-up window (OP_CATCHUP_TIMEOUT_MS = 3000):
    // every drained op is rolled back by the pin mismatch, so no chain ever
    // persists and the gate drops the message fail-closed.
    await new Promise((resolve) => setTimeout(resolve, 3500));
    expect(carolMessages.length).toBe(0);
    expect(carol.membershipLogFor(convId)).toBeUndefined();

    alice.disconnect();
    carol.disconnect();
  }, 30_000);
});

describe("membership gate: listMembers roster is authoritative from the fold (Phase C)", () => {
  it("C-1': op-log-only-removed member is excluded from listMembers despite the relay still listing them active; remaining members keep enriched deviceIds and aiMode still round-trips", async () => {
    const alice = await signupClient(relayUrl(), uniqueUsername("alice"));
    const bob = await signupClient(relayUrl(), uniqueUsername("bob"));
    const carol = await signupClient(relayUrl(), uniqueUsername("carol"));

    await alice.resolveUser(bob.username);
    await alice.resolveUser(carol.username);
    await bob.resolveUser(alice.username);
    await bob.resolveUser(carol.username);
    await carol.resolveUser(alice.username);
    await carol.resolveUser(bob.username);

    const convId = await alice.createConversation([bob.userId, carol.userId]);
    await bob.listMembers(convId); // drain genesis so bob holds a chain
    await carol.listMembers(convId); // drain genesis so carol holds a chain (fold gate has something to gate against)

    // op-log-only-remove bob: relay keeps him active (exactly like B-1) — the REST
    // DELETE is skipped so the relay-listed roster still includes him, isolating
    // the fold as the ONLY thing that can exclude him from carol's listMembers.
    await opLogOnlyRemove(alice, convId, bob.userId);
    await waitUntil(() => (carol.membershipLogFor(convId)?.head().seq ?? -1) >= 1, 10_000);

    // Round-trip aiMode through the relay (single-writer, non-authority toggle)
    // while bob is gone from the fold, proving the gate doesn't disturb it.
    await alice.setAiMode(convId, true);

    const carolRoster = await carol.listMembers(convId);

    // Bob: excluded from the roster (fold authority), DESPITE the relay still
    // listing him as an active member.
    expect(carolRoster.find((m) => m.userId === bob.userId)).toBeUndefined();

    // Alice + carol: still present, still enriched with non-empty deviceIds —
    // proving the relay round-trip still supplies the device directory for
    // members the fold retains.
    const aliceEntries = carolRoster.filter((m) => m.userId === alice.userId);
    const carolEntries = carolRoster.filter((m) => m.userId === carol.userId);
    expect(aliceEntries.length).toBeGreaterThan(0);
    expect(carolEntries.length).toBeGreaterThan(0);
    expect(aliceEntries.every((m) => m.deviceId)).toBe(true);
    expect(carolEntries.every((m) => m.deviceId)).toBe(true);

    // aiMode still round-trips off the relay (relay-single-writer path is
    // untouched by the fold gate on the returned Member[]).
    expect(carol.getAiMode(convId)).toBe(true);

    alice.disconnect();
    bob.disconnect();
    carol.disconnect();
  }, 30_000);
});
