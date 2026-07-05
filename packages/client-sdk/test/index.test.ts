import { describe, expect, it } from "vitest";
import { SignalAiClient } from "../src/index.js";

describe("SignalAiClient", () => {
  it("stores the configured relay URL", () => {
    const client = new SignalAiClient({ relayUrl: "wss://relay.example.com" });
    expect(client.relayUrl).toBe("wss://relay.example.com");
  });

  it("generates a real Signal-protocol registration id on construction", () => {
    const client = new SignalAiClient({ relayUrl: "wss://relay.example.com" });
    expect(Number.isInteger(client.registrationId)).toBe(true);
  });

  it("parses envelopes via the shared proto schema", () => {
    const client = new SignalAiClient({ relayUrl: "wss://relay.example.com" });
    const envelope = client.parseIncomingEnvelope({
      conversationId: "conv-1",
      senderUserId: "user-1",
      senderDeviceId: 1,
      recipientDeviceId: 1,
      seq: 1,
      ciphertext: "AQID",
      type: 3,
    });
    expect(envelope.conversationId).toBe("conv-1");
  });
});
