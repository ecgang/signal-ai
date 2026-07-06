import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { type P2pDialOptions, type P2pNode as P2pNodeType, type P2pSocket } from "@signalai/p2p";
import { resolveTransport, transportModeFromEnv } from "../src/transport-select.js";

/**
 * Flag-gated, default-OFF transport selector (plans/002 / design §C): the
 * message plane can be flipped to P2P via `mode`/`SIGNALAI_TRANSPORT` while
 * directory/account/membership stay on the relay. These tests use a fake
 * `node` so "p2p" mode never touches a real DHT or WebSocket.
 */
class FakeSocket extends EventEmitter {
  write(): boolean {
    return true;
  }
  destroy(): void {}
}

class FakeNode {
  readonly dials: Buffer[] = [];
  dial(publicKey: Buffer, _opts?: P2pDialOptions): P2pSocket {
    this.dials.push(publicKey);
    return new FakeSocket() as unknown as P2pSocket;
  }
}

const relayUrl = "http://localhost:9-nonexistent"; // never contacted: no test here opens a real socket.

describe("resolveTransport", () => {
  it("default (no mode, no env) ⇒ returns the relay transport (REST methods + openSocket present)", () => {
    const t = resolveTransport({ relayUrl });
    expect(typeof t.signup).toBe("function");
    expect(typeof t.listMembers).toBe("function");
    expect(typeof t.openSocket).toBe("function");
  });

  it('mode:"p2p" ⇒ membership/directory stay on the relay but openSocket dials P2P (no WebSocket)', () => {
    const node = new FakeNode();
    const t = resolveTransport({
      relayUrl,
      mode: "p2p",
      p2p: { peerPublicKey: Buffer.from("peer-key"), node: node as unknown as P2pNodeType },
    });

    // Directory/account/membership planes are still the relay's REST closures.
    expect(typeof t.signup).toBe("function");
    expect(typeof t.listMembers).toBe("function");

    // openSocket is the P2P one: it dials the node, it does NOT open a ws.
    t.openSocket();
    expect(node.dials.length).toBe(1);
    expect(node.dials[0]).toEqual(Buffer.from("peer-key"));
  });

  it('mode:"p2p" with NO p2p options ⇒ throws requiring p2p options', () => {
    expect(() => resolveTransport({ relayUrl, mode: "p2p" })).toThrow(/requires p2p options/);
  });
});

describe("transportModeFromEnv", () => {
  it('returns "p2p" only for SIGNALAI_TRANSPORT === "p2p"', () => {
    expect(transportModeFromEnv({ SIGNALAI_TRANSPORT: "p2p" } as NodeJS.ProcessEnv)).toBe("p2p");
  });

  it('returns "relay" for an empty env and for any other value', () => {
    expect(transportModeFromEnv({} as NodeJS.ProcessEnv)).toBe("relay");
    expect(transportModeFromEnv({ SIGNALAI_TRANSPORT: "relay" } as NodeJS.ProcessEnv)).toBe("relay");
    expect(transportModeFromEnv({ SIGNALAI_TRANSPORT: "something-else" } as NodeJS.ProcessEnv)).toBe("relay");
  });
});
