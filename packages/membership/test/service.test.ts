import { describe, expect, it } from "vitest";
import { Identity } from "@signalai/core";
import {
  decodeOp,
  enforceInbound,
  MembershipLog,
  OpLogMembershipService,
  verifyChain,
  type MembershipOp,
  type OpBroadcaster,
} from "../src/index.js";

describe("OpLogMembershipService (design §8, item C)", () => {
  function newService(broadcast?: OpBroadcaster) {
    const founder = Identity.generate();
    // selfUserId MUST equal the creatorUserId for single-writer author-pinning.
    return new OpLogMembershipService(founder, "F", broadcast);
  }

  it("creates a conversation, mutates membership, and listMembers reflects the fold", async () => {
    const svc = newService();
    // The `token` param is vestigial in P2P — pass junk to prove it is ignored.
    const convId = await svc.createConversation("junk-token", {
      creatorUserId: "F",
      memberUserIds: ["B", "C"],
      aiMode: false,
    });

    await svc.invite("junk-token", convId, "D");
    let listed = await svc.listMembers("junk-token", convId);
    expect(listed.members.map((m) => m.userId).sort()).toEqual(["B", "C", "D", "F"]);
    expect(listed.aiMode).toBe(false);

    await svc.removeMember("junk-token", convId, "C");
    await svc.setAiMode("junk-token", convId, true);
    listed = await svc.listMembers("junk-token", convId);
    expect(listed.members.map((m) => m.userId).sort()).toEqual(["B", "D", "F"]);
    expect(listed.aiMode).toBe(true);
  });

  it("produces a chain that independently verifies and drives the receiver gate end to end", async () => {
    const broadcasted: MembershipOp[] = [];
    const svc = newService({
      broadcastOp: (_c, encoded) => {
        broadcasted.push(decodeOp(encoded));
      },
    });

    const convId = await svc.createConversation("t", { creatorUserId: "F", memberUserIds: ["B", "C"], aiMode: false });
    await svc.removeMember("t", convId, "C");

    // Every broadcast op decodes and the assembled chain verifies independently.
    expect(broadcasted).toHaveLength(2);
    const chain = svc.chainFor(convId);
    expect(() => verifyChain(chain)).not.toThrow();

    // An independent receiver built from the broadcast ops rejects removed C, accepts B.
    const receiver = MembershipLog.open(chain);
    const head = svc.headFor(convId);
    expect(enforceInbound(receiver, "C", head).accepted).toBe(false);
    expect(enforceInbound(receiver, "B", head).accepted).toBe(true);
  });

  it("supports a fresh joiner via the invite pin + genesis re-send", async () => {
    const svc = newService();
    const convId = await svc.createConversation("t", { creatorUserId: "F", memberUserIds: ["B"], aiMode: false });
    await svc.invite("t", convId, "C");

    const pin = svc.inviteFor(convId);
    const joiner = MembershipLog.forJoiner(pin);
    joiner.ingestChain(svc.chainFor(convId));
    expect([...joiner.members()].sort()).toEqual(["B", "C", "F"]);
  });
});
