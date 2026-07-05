import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { startRelay, stopRelay, resetDb, signupClient, uniqueUsername, waitUntil, type RelayHarness } from "./helpers.js";
import type { IncomingMessage } from "../src/index.js";

/**
 * chat-cli smoke: exercises the EXACT flow tools/chat-cli.ts drives (signup ->
 * resolveUser -> create/join conversation -> send -> onMessage) with two real
 * SignalAiClient instances over a real relay + real WebSocket, and prints a
 * two-terminal-style transcript. This is the automated stand-in for the manual
 * two-terminal demo (Phase 4 acceptance criterion #9); the transcript it emits
 * is the captured snippet.
 */
describe("chat-cli two-terminal smoke", () => {
  let harness: RelayHarness;
  beforeAll(async () => {
    harness = await startRelay();
    await resetDb(harness.prisma);
  });
  afterAll(async () => {
    await stopRelay(harness);
  });

  it("two CLI instances exchange messages through a live relay", async () => {
    const log = (line: string): void => console.log(`  [cli] ${line}`);

    // --- Terminal 1: alice ---
    const aliceName = uniqueUsername("alice");
    const alice = await signupClient(harness.relayUrl, aliceName);
    log(`signed up as "${aliceName}" (userId ${alice.userId}), connected.`);

    // --- Terminal 2: bob ---
    const bobName = uniqueUsername("bob");
    const bob = await signupClient(harness.relayUrl, bobName);
    log(`signed up as "${bobName}" (userId ${bob.userId}), connected.`);

    const aliceInbox: IncomingMessage[] = [];
    const bobInbox: IncomingMessage[] = [];
    alice.onMessage = (m) => {
      aliceInbox.push(m);
      log(`alice sees -> ${m.senderUserId === bob.userId ? bobName : m.senderUserId}: ${m.text}`);
    };
    bob.onMessage = (m) => {
      bobInbox.push(m);
      log(`bob sees   -> ${m.senderUserId === alice.userId ? aliceName : m.senderUserId}: ${m.text}`);
    };

    // Contact-book step both terminals prompt for.
    await alice.resolveUser(bobName);
    await bob.resolveUser(aliceName);

    // Terminal 1 creates the conversation and prints its id; Terminal 2 joins it.
    const convId = await alice.createConversation([bob.userId]);
    log(`alice created conversation. conversation id: ${convId}`);
    await bob.listMembers(convId);
    log(`bob joined conversation ${convId}.`);

    // Exchange, both directions.
    await alice.send(convId, "hey bob, this is alice over the CLI");
    await waitUntil(() => bobInbox.length === 1);
    await bob.send(convId, "got it alice — bob here, reading you clearly");
    await waitUntil(() => aliceInbox.length === 1);

    expect(bobInbox[0]!.text).toBe("hey bob, this is alice over the CLI");
    expect(aliceInbox[0]!.text).toBe("got it alice — bob here, reading you clearly");
    log("transcript OK — both directions delivered and decrypted.");

    alice.disconnect();
    bob.disconnect();
  }, 20_000);
});
