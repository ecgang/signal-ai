import { describe, expect, it } from "vitest";
import * as proto from "../src/index.js";
import {
  parseEnvelope,
  parsePlaintextMessage,
  parseWsFrame,
  PreKeyBundlePublicSchema,
  SignupRequestSchema,
  SignupResponseSchema,
  PublishDeviceRequestSchema,
  PublishDeviceResponseSchema,
  FetchPreKeyBundleRequestSchema,
  FetchPreKeyBundleResponseSchema,
  CreateConversationRequestSchema,
  CreateConversationResponseSchema,
  InviteMemberRequestSchema,
  RemoveMemberRequestSchema,
  MutateMemberResponseSchema,
  SetAiModeRequestSchema,
  SetAiModeResponseSchema,
  ListMembersRequestSchema,
  ListMembersResponseSchema,
  WsOpSendFrameSchema,
  WsOpDeliverFrameSchema,
} from "../src/index.js";

const validBundle = {
  userId: "user-1",
  deviceId: 1,
  registrationId: 1234,
  identityKey: "aWRlbnRpdHk=",
  signedPreKeyId: 1,
  signedPreKeyPublic: "c2lnbmVk",
  signedPreKeySignature: "c2ln",
  kyberPreKeyId: 1,
  kyberPreKeyPublic: "a3liZXI=",
  kyberPreKeySignature: "a3NpZw==",
};

describe("EnvelopeSchema / parseEnvelope", () => {
  it("parses a valid envelope", () => {
    const envelope = parseEnvelope({
      conversationId: "conv-1",
      senderUserId: "user-1",
      senderDeviceId: 1,
      recipientDeviceId: 2,
      seq: 1,
      ciphertext: "AQID",
      type: 3,
    });

    expect(envelope.conversationId).toBe("conv-1");
    expect(envelope.type).toBe(3);
  });

  it("rejects an envelope missing required fields", () => {
    expect(() => parseEnvelope({ conversationId: "" })).toThrow();
  });

  it("rejects an envelope with an invalid ciphertext type", () => {
    expect(() =>
      parseEnvelope({
        conversationId: "conv-1",
        senderUserId: "user-1",
        senderDeviceId: 1,
        recipientDeviceId: 2,
        seq: 1,
        ciphertext: "AQID",
        type: 7, // SenderKey — not a type signal-ai's pairwise fan-out ever emits
      }),
    ).toThrow();
  });
});

describe("PlaintextMessageSchema / parsePlaintextMessage", () => {
  it("parses a valid plaintext message", () => {
    const message = parsePlaintextMessage({
      msgId: "msg-1",
      text: "hello @bob",
      mentions: ["bob"],
      sentAt: Date.now(),
    });
    expect(message.text).toBe("hello @bob");
    expect(message.mentions).toEqual(["bob"]);
  });

  it("rejects a plaintext message missing msgId", () => {
    expect(() => parsePlaintextMessage({ text: "hi", mentions: [], sentAt: 0 })).toThrow();
  });
});

describe("WsFrameSchema / parseWsFrame", () => {
  it("parses a deliver frame", () => {
    const frame = parseWsFrame({
      type: "deliver",
      envelope: {
        conversationId: "conv-1",
        senderUserId: "user-1",
        senderDeviceId: 1,
        recipientDeviceId: 2,
        seq: 1,
        ciphertext: "AQID",
        type: 2,
      },
    });
    expect(frame.type).toBe("deliver");
  });

  it("parses an ack frame", () => {
    const frame = parseWsFrame({ type: "ack", conversationId: "conv-1", seq: 3 });
    expect(frame.type).toBe("ack");
  });

  it("parses a subscribe frame with and without sinceSeq", () => {
    expect(parseWsFrame({ type: "subscribe", conversationId: "conv-1" }).type).toBe("subscribe");
    expect(parseWsFrame({ type: "subscribe", conversationId: "conv-1", sinceSeq: 5 }).type).toBe("subscribe");
  });

  it("rejects a frame with an unknown discriminant", () => {
    expect(() => parseWsFrame({ type: "not-a-real-frame" })).toThrow();
  });

  it("parses op-send / op-deliver frames (opaque base64 `op`, cleartext seq)", () => {
    const op = "b3BhcXVlLW9wLWJ5dGVz"; // arbitrary base64 — proto never decodes it
    const opSend = parseWsFrame({ type: "op-send", conversationId: "conv-1", seq: 0, op });
    expect(opSend.type).toBe("op-send");
    const opDeliver = parseWsFrame({ type: "op-deliver", conversationId: "conv-1", seq: 0, op });
    expect(opDeliver.type).toBe("op-deliver");
  });

  it("rejects op-send/op-deliver frames missing required fields", () => {
    expect(() => WsOpSendFrameSchema.parse({ type: "op-send", conversationId: "conv-1", seq: 0 })).toThrow();
    expect(() => WsOpSendFrameSchema.parse({ type: "op-send", conversationId: "", seq: 0, op: "AQ==" })).toThrow();
    expect(() =>
      WsOpDeliverFrameSchema.parse({ type: "op-deliver", conversationId: "conv-1", seq: -1, op: "AQ==" }),
    ).toThrow();
  });
});

describe("PreKeyBundlePublicSchema", () => {
  it("parses a bundle without a one-time prekey", () => {
    expect(() => PreKeyBundlePublicSchema.parse(validBundle)).not.toThrow();
  });

  it("parses a bundle with a one-time prekey", () => {
    expect(() =>
      PreKeyBundlePublicSchema.parse({ ...validBundle, preKeyId: 1, preKeyPublic: "b25ldGltZQ==" }),
    ).not.toThrow();
  });

  it("rejects a bundle missing the mandatory kyber prekey fields", () => {
    const withoutKyber: Record<string, unknown> = { ...validBundle };
    delete withoutKyber.kyberPreKeyId;
    expect(() => PreKeyBundlePublicSchema.parse(withoutKyber)).toThrow();
  });
});

describe("relay REST contract schemas", () => {
  it("parses signup request/response", () => {
    expect(() => SignupRequestSchema.parse({ username: "alice" })).not.toThrow();
    expect(() => SignupResponseSchema.parse({ userId: "user-1" })).not.toThrow();
    expect(() => SignupRequestSchema.parse({ username: "" })).toThrow();
  });

  it("parses device+prekey publish request/response", () => {
    expect(() =>
      PublishDeviceRequestSchema.parse({ userId: "user-1", bundle: validBundle }),
    ).not.toThrow();
    expect(() => PublishDeviceResponseSchema.parse({ ok: true })).not.toThrow();
  });

  it("parses prekey-bundle fetch request/response", () => {
    expect(() => FetchPreKeyBundleRequestSchema.parse({ userId: "user-1" })).not.toThrow();
    expect(() => FetchPreKeyBundleRequestSchema.parse({ userId: "user-1", deviceId: 2 })).not.toThrow();
    expect(() =>
      FetchPreKeyBundleResponseSchema.parse({ bundles: [validBundle] }),
    ).not.toThrow();
  });

  it("parses conversation create request/response", () => {
    expect(() =>
      CreateConversationRequestSchema.parse({ creatorUserId: "user-1", memberUserIds: ["user-2"] }),
    ).not.toThrow();
    expect(() => CreateConversationResponseSchema.parse({ conversationId: "conv-1" })).not.toThrow();
    // An empty member list is valid: the creator is always added by the relay,
    // so a creator-only conversation is well-formed (the CLI's `/new <name>`
    // starts a thread before anyone is invited).
    expect(() =>
      CreateConversationRequestSchema.parse({ creatorUserId: "user-1", memberUserIds: [] }),
    ).not.toThrow();
    // Still rejects malformed entries (a non-string / empty member id).
    expect(() =>
      CreateConversationRequestSchema.parse({ creatorUserId: "user-1", memberUserIds: [""] }),
    ).toThrow();
  });

  it("parses invite/remove requests and the shared mutation response", () => {
    expect(() => InviteMemberRequestSchema.parse({ conversationId: "conv-1", userId: "user-2" })).not.toThrow();
    expect(() => RemoveMemberRequestSchema.parse({ conversationId: "conv-1", userId: "user-2" })).not.toThrow();
    expect(() => MutateMemberResponseSchema.parse({ ok: true })).not.toThrow();
  });

  it("parses setAiMode request/response", () => {
    expect(() => SetAiModeRequestSchema.parse({ conversationId: "conv-1", enabled: true })).not.toThrow();
    expect(() => SetAiModeResponseSchema.parse({ ok: true })).not.toThrow();
  });

  it("parses listMembers request/response", () => {
    expect(() => ListMembersRequestSchema.parse({ conversationId: "conv-1" })).not.toThrow();
    expect(() =>
      ListMembersResponseSchema.parse({ members: [{ userId: "user-1", deviceIds: [1, 2] }], aiMode: true }),
    ).not.toThrow();
    // aiMode is a required wire field (phase 6A): a response missing it is rejected.
    expect(() =>
      ListMembersResponseSchema.parse({ members: [{ userId: "user-1", deviceIds: [1, 2] }] }),
    ).toThrow();
  });
});

describe("full schema set export surface", () => {
  it("exports every schema and parse helper the wire+REST contract owns", () => {
    const expectedZodSchemaNames = [
      "CiphertextTypeSchema",
      "EnvelopeSchema",
      "PlaintextMessageSchema",
      "WsDeliverFrameSchema",
      "WsAckFrameSchema",
      "WsSubscribeFrameSchema",
      "WsOpSendFrameSchema",
      "WsOpDeliverFrameSchema",
      "WsFrameSchema",
      "PreKeyBundlePublicSchema",
      "SignupRequestSchema",
      "SignupResponseSchema",
      "PublishDeviceRequestSchema",
      "PublishDeviceResponseSchema",
      "FetchPreKeyBundleRequestSchema",
      "FetchPreKeyBundleResponseSchema",
      "CreateConversationRequestSchema",
      "CreateConversationResponseSchema",
      "InviteMemberRequestSchema",
      "RemoveMemberRequestSchema",
      "MutateMemberResponseSchema",
      "SetAiModeRequestSchema",
      "SetAiModeResponseSchema",
      "ConversationMemberSchema",
      "ListMembersRequestSchema",
      "ListMembersResponseSchema",
    ] as const;

    for (const name of expectedZodSchemaNames) {
      const schema = proto[name];
      expect(schema, `expected proto to export ${name}`).toBeDefined();
      expect(typeof schema.parse, `expected ${name} to be a zod schema`).toBe("function");
    }

    const expectedParseHelperNames = ["parseEnvelope", "parsePlaintextMessage", "parseWsFrame"] as const;
    for (const name of expectedParseHelperNames) {
      expect(typeof proto[name], `expected proto to export ${name} as a function`).toBe("function");
    }
  });
});
