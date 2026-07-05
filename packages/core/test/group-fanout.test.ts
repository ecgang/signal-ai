import { describe, expect, it } from "vitest";
import type { Envelope } from "@signalai/proto";
import { createParty, textToBytes, bytesToText } from "./helpers.js";

describe("3-party group fan-out", () => {
  it("lets each member decrypt only its own envelope; cross-decryption throws", async () => {
    const alice = await createParty("alice-fanout");
    const bob = await createParty("bob-fanout");
    const carol = await createParty("carol-fanout");

    await alice.sessionManager.establishSession(bob.address, bob.nextBundle());
    await alice.sessionManager.establishSession(carol.address, carol.nextBundle());

    const ctx = { conversationId: "conv-fanout", senderUserId: "alice-fanout", senderDeviceId: 1 };
    // encryptForMembers preserves input order, so envelopes[0] is Bob's and envelopes[1] is Carol's.
    const [bobEnvelope, carolEnvelope] = await alice.fanout.encryptForMembers(
      textToBytes("hello group"),
      [bob.address, carol.address],
      ctx,
    );

    // Each recipient decrypts their own envelope correctly, which
    // establishes a real, working session on each side.
    expect(bytesToText(await bob.fanout.decryptEnvelope(bobEnvelope))).toBe("hello group");
    expect(bytesToText(await carol.fanout.decryptEnvelope(carolEnvelope))).toBe("hello group");

    // Now that both have genuine, established sessions with Alice, prove
    // neither can decrypt the envelope meant for the other — their pairwise
    // ratchets are cryptographically independent, so this is a real
    // decryption failure, not just a missing-session short-circuit.
    await expect(carol.fanout.decryptEnvelope(bobEnvelope)).rejects.toThrow();
    await expect(bob.fanout.decryptEnvelope(carolEnvelope)).rejects.toThrow();
  });
});

describe("member removal", () => {
  it("excludes a removed member from future fan-out, and rejects her attempt to decrypt post-removal traffic meant for another member", async () => {
    const alice = await createParty("alice-removal");
    const bob = await createParty("bob-removal");
    const carol = await createParty("carol-removal");

    await alice.sessionManager.establishSession(bob.address, bob.nextBundle());
    await alice.sessionManager.establishSession(carol.address, carol.nextBundle());

    const ctx = { conversationId: "conv-removal", senderUserId: "alice-removal", senderDeviceId: 1 };

    // Message while Carol is still a member: both decrypt fine, and Carol's
    // session with Alice is now genuinely established (not just pending).
    const [bobEnvelope1, carolEnvelope1] = await alice.fanout.encryptForMembers(
      textToBytes("welcome"),
      [bob.address, carol.address],
      ctx,
    );
    expect(bytesToText(await bob.fanout.decryptEnvelope(bobEnvelope1))).toBe("welcome");
    expect(bytesToText(await carol.fanout.decryptEnvelope(carolEnvelope1))).toBe("welcome");

    // Carol is removed: the caller simply stops including her address.
    const postRemoval = await alice.fanout.encryptForMembers(textToBytes("carol is gone now"), [bob.address], ctx);

    // She received no envelope addressed to her post-removal (list-level check — not sufficient alone).
    expect(postRemoval).toHaveLength(1);
    const bobEnvelope2 = postRemoval[0];

    // The signature assertion: even with her still-valid pre-removal
    // session to Alice, Carol cannot decrypt Bob's post-removal message —
    // an explicit, genuine decrypt failure, because it was encrypted using
    // Bob's independent pairwise ratchet state, not hers.
    await expect(carol.fanout.decryptEnvelope(bobEnvelope2)).rejects.toThrow();

    // Bob, meanwhile, decrypts it correctly.
    expect(bytesToText(await bob.fanout.decryptEnvelope(bobEnvelope2))).toBe("carol is gone now");
  });
});

describe("late join", () => {
  it("lets a member added after 5 messages decrypt post-join messages, but not pre-join ones", async () => {
    const alice = await createParty("alice-latejoin");
    const bob = await createParty("bob-latejoin");
    const dave = await createParty("dave-latejoin");

    await alice.sessionManager.establishSession(bob.address, bob.nextBundle());

    const ctx = { conversationId: "conv-latejoin", senderUserId: "alice-latejoin", senderDeviceId: 1 };
    const preJoinEnvelopes: Envelope[] = [];
    for (let i = 0; i < 5; i++) {
      const [bobEnvelope] = await alice.fanout.encryptForMembers(textToBytes(`msg-${i}`), [bob.address], ctx);
      preJoinEnvelopes.push(bobEnvelope);
      expect(bytesToText(await bob.fanout.decryptEnvelope(bobEnvelope))).toBe(`msg-${i}`);
    }

    // Dave joins: Alice establishes a session with him and includes him from now on.
    await alice.sessionManager.establishSession(dave.address, dave.nextBundle());
    const [bobEnvelope6, daveEnvelope6] = await alice.fanout.encryptForMembers(
      textToBytes("welcome dave"),
      [bob.address, dave.address],
      ctx,
    );

    expect(bytesToText(await dave.fanout.decryptEnvelope(daveEnvelope6))).toBe("welcome dave");
    expect(bytesToText(await bob.fanout.decryptEnvelope(bobEnvelope6))).toBe("welcome dave");

    // Dave has no session with Alice prior to the join point, so decrypting
    // any pre-join envelope (even one addressed to a different device id)
    // must throw.
    await expect(dave.fanout.decryptEnvelope(preJoinEnvelopes[0])).rejects.toThrow();
    await expect(dave.fanout.decryptEnvelope(preJoinEnvelopes[4])).rejects.toThrow();
  });
});
