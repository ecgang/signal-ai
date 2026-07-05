import { describe, it, expect } from "vitest";
import { CiphertextMessageType, ProtocolAddress, SessionRecord } from "@signalapp/libsignal-client";
import { createParty, textToBytes, bytesToText } from "./helpers.js";

/**
 * Regression guard for the SessionManager store mutex.
 *
 * libsignal's encrypt/decrypt each read-modify-write the single pairwise
 * SessionRecord (getSession -> ratchet step -> saveSession). A client encrypts
 * (send) off its own call path while its inbox chain decrypts concurrently, so
 * without serialization a concurrent encrypt+decrypt for the SAME peer
 * interleave their RMW, clobber the record, and desync the ratchet -- after
 * which a later decrypt throws and (because the client drops undecryptable
 * envelopes) the message is silently lost. Only a group's simultaneous
 * cross-peer traffic hits this, which is why 1:1 flows never did.
 *
 * To make the race deterministic instead of timing-dependent, we widen the RMW
 * window by injecting a macrotask yield into Alice's session store get/save.
 * WITH the mutex, SessionManager serializes the ops so the widened window is
 * irrelevant and every message round-trips. Remove the mutex and the injected
 * yields guarantee the interleave -- and this test fails.
 */
describe("SessionManager serializes concurrent store access", () => {
  it("loses no message when a client encrypts and decrypts the same peer concurrently", async () => {
    const alice = await createParty("alice-concurrency");
    const bob = await createParty("bob-concurrency");

    // Single-initiator session (Alice -> Bob) plus a reply, so every message in
    // the concurrent hot path below is a Whisper (no PreKey/session-establish).
    await alice.sessionManager.establishSession(bob.address, bob.nextBundle());
    const init = await alice.sessionManager.encrypt(bob.address, textToBytes("init"));
    expect(bytesToText(await bob.sessionManager.decrypt(alice.address, init.type(), init.serialize()))).toBe("init");
    const ack = await bob.sessionManager.encrypt(alice.address, textToBytes("ack"));
    expect(ack.type()).toBe(CiphertextMessageType.Whisper);
    expect(bytesToText(await alice.sessionManager.decrypt(bob.address, ack.type(), ack.serialize()))).toBe("ack");

    // Bob pre-encrypts a batch to Alice (all Whisper, sequential on his chain).
    const N = 12;
    const fromBob: Uint8Array[] = [];
    for (let i = 0; i < N; i++) {
      const c = await bob.sessionManager.encrypt(alice.address, textToBytes(`from-bob-${i}`));
      expect(c.type()).toBe(CiphertextMessageType.Whisper);
      fromBob.push(c.serialize());
    }

    // Widen the read-modify-write window on Alice's session store so a missing
    // mutex would deterministically interleave (and clobber) concurrent ops.
    const sstore = alice.stores.session;
    const origGet = sstore.getSession.bind(sstore);
    const origSave = sstore.saveSession.bind(sstore);
    const yield0 = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
    sstore.getSession = async (name: ProtocolAddress): Promise<SessionRecord | null> => {
      const rec = await origGet(name);
      await yield0();
      return rec;
    };
    sstore.saveSession = async (name: ProtocolAddress, record: SessionRecord): Promise<void> => {
      await yield0();
      await origSave(name, record);
    };

    // Fire N decrypts (Bob -> Alice) and N encrypts (Alice -> Bob) all at once.
    const decryptTasks = fromBob.map((ct) =>
      alice.sessionManager.decrypt(bob.address, CiphertextMessageType.Whisper, ct).then(bytesToText),
    );
    const encryptTasks = Array.from({ length: N }, (_, i) =>
      alice.sessionManager.encrypt(bob.address, textToBytes(`from-alice-${i}`)),
    );
    const [received, produced] = await Promise.all([Promise.all(decryptTasks), Promise.all(encryptTasks)]);

    // Every message Bob sent decrypted correctly on Alice under the concurrency...
    expect([...received].sort()).toEqual(Array.from({ length: N }, (_, i) => `from-bob-${i}`).sort());

    // ...and every ciphertext Alice produced concurrently is still decryptable by Bob
    // (a clobbered sending ratchet would make one of these throw or decode wrong).
    const atBob: string[] = [];
    for (const ct of produced) {
      atBob.push(bytesToText(await bob.sessionManager.decrypt(alice.address, ct.type(), ct.serialize())));
    }
    expect(atBob.sort()).toEqual(Array.from({ length: N }, (_, i) => `from-alice-${i}`).sort());
  });
});
