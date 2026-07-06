import { describe, expect, it } from "vitest";
import { createParty, textToBytes, bytesToText } from "./helpers.js";

/**
 * §F.1 (docs/design/p2p-transport.md §F) — the highest-severity fact the P2P
 * design depends on: `GroupFanout.encryptForMembers` (packages/core/src/group.ts)
 * must use NO shared group-wide symmetric sender-key. If a shared sender-key
 * existed, removing a member would require epoch rotation (rekeying everyone
 * else), not just excluding the removed address from future fan-out calls.
 * This test pins the current (correct) behavior with executable assertions so
 * a future refactor can't silently introduce a shared sender-key — see the
 * plan's Maintenance note (plans/001-p1-interface-split.md) and the design
 * doc's §F.1 row.
 */
describe("F.1 — group fan-out has no shared group-wide symmetric sender-key", () => {
  it("F.1: encrypting one plaintext to N recipients yields N independent per-recipient ciphertexts, not one shared blob", async () => {
    const alice = await createParty("alice-f1-distinct");
    const bob = await createParty("bob-f1-distinct");
    const carol = await createParty("carol-f1-distinct");

    await alice.sessionManager.establishSession(bob.address, bob.nextBundle());
    await alice.sessionManager.establishSession(carol.address, carol.nextBundle());

    const ctx = { conversationId: "conv-f1-distinct", senderUserId: "alice-f1-distinct", senderDeviceId: 1 };
    const [bobEnvelope, carolEnvelope] = await alice.fanout.encryptForMembers(
      textToBytes("same plaintext to both"),
      [bob.address, carol.address],
      ctx,
    );

    // A shared group-wide sender-key would (at minimum) be capable of
    // producing identical ciphertext bytes for identical plaintext under the
    // same key/counter step, or would let one recipient's ratchet decrypt the
    // other's envelope (checked next). Assert the raw ciphertexts differ:
    // each recipient's envelope was sealed under its own independent
    // pairwise Double Ratchet state with the sender, not a shared key.
    expect(bobEnvelope.ciphertext).not.toEqual(carolEnvelope.ciphertext);
  });

  it("F.1: a recipient's session decrypts only its own envelope — no key exists that both recipients' sessions share", async () => {
    const alice = await createParty("alice-f1-cross");
    const bob = await createParty("bob-f1-cross");
    const carol = await createParty("carol-f1-cross");

    await alice.sessionManager.establishSession(bob.address, bob.nextBundle());
    await alice.sessionManager.establishSession(carol.address, carol.nextBundle());

    const ctx = { conversationId: "conv-f1-cross", senderUserId: "alice-f1-cross", senderDeviceId: 1 };
    const [bobEnvelope, carolEnvelope] = await alice.fanout.encryptForMembers(
      textToBytes("pairwise only"),
      [bob.address, carol.address],
      ctx,
    );

    // Genuine sessions on both sides first (a missing-session short-circuit
    // would be a weaker, non-cryptographic reason to fail).
    expect(bytesToText(await bob.fanout.decryptEnvelope(bobEnvelope))).toBe("pairwise only");
    expect(bytesToText(await carol.fanout.decryptEnvelope(carolEnvelope))).toBe("pairwise only");

    // If a shared group-wide sender-key existed, either recipient could use
    // it to decrypt the other's envelope. Both directions must throw: this
    // is the direct evidence that no such shared key exists — each envelope
    // is only decryptable from the one pairwise ratchet it was sealed to.
    await expect(carol.fanout.decryptEnvelope(bobEnvelope)).rejects.toThrow();
    await expect(bob.fanout.decryptEnvelope(carolEnvelope)).rejects.toThrow();
  });

  it("F.1: after a caller-side removal, the removed member's still-valid session cannot decrypt later traffic (no shared key to rotate)", async () => {
    const alice = await createParty("alice-f1-removal");
    const bob = await createParty("bob-f1-removal");
    const carol = await createParty("carol-f1-removal");

    await alice.sessionManager.establishSession(bob.address, bob.nextBundle());
    await alice.sessionManager.establishSession(carol.address, carol.nextBundle());

    const ctx = { conversationId: "conv-f1-removal", senderUserId: "alice-f1-removal", senderDeviceId: 1 };

    // Establish a genuine session for Carol before "removing" her.
    const [, carolEnvelope1] = await alice.fanout.encryptForMembers(
      textToBytes("carol is still here"),
      [bob.address, carol.address],
      ctx,
    );
    expect(bytesToText(await carol.fanout.decryptEnvelope(carolEnvelope1))).toBe("carol is still here");

    // Removal, as designed (§B.2 of the design doc): purely a caller-side
    // decision to stop passing Carol's address into encryptForMembers. No
    // key revocation / rotation call exists anywhere in this API — if a
    // shared sender-key existed, that absence would be a bug, not a feature.
    const [bobEnvelope2] = await alice.fanout.encryptForMembers(textToBytes("carol is gone"), [bob.address], ctx);

    // Carol's pairwise session with Alice is still cryptographically valid
    // (nothing revoked it), yet she cannot decrypt Bob's post-removal
    // envelope: it was never sealed under any key she holds or could
    // derive. This is "removal loses sender-side confidentiality" verified
    // as code, not merely asserted in docs.
    await expect(carol.fanout.decryptEnvelope(bobEnvelope2)).rejects.toThrow();
    expect(bytesToText(await bob.fanout.decryptEnvelope(bobEnvelope2))).toBe("carol is gone");
  });
});
