import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import createTestnet, { type Testnet } from "@hyperswarm/testnet";
import {
  createP2pNode,
  P2pNode,
  type P2pDialOptions,
  type P2pNode as P2pNodeType,
  type P2pSocket,
} from "@signalai/p2p";
import { EnvelopeSchema, parseEnvelope, type Envelope } from "@signalai/proto";
import { createP2pTransport } from "../src/transport-p2p.js";
import type { ClientSocket } from "../src/transport.js";

/**
 * P0 connectivity spike (plans/002-p0-p2p-transport.md), client-sdk level:
 * proves `createP2pTransport()`'s `MessageTransport` carries a realistic
 * `EnvelopeSchema`-shaped ciphertext byte-for-byte between two peers, with no
 * relay in the loop, and that its replay/mailbox buffer (`drain`) queues
 * frames sent before the underlying connection opens and flushes them once it
 * does.
 *
 * The envelope is built and parsed here only for realism (`@signalai/proto`
 * is a test-only import) — `transport-p2p.ts` itself never imports
 * `@signalai/proto` and never parses the frame; it treats every `send()`
 * payload as an opaque string. See `packages/p2p/test/two-peer.test.ts` for
 * the equivalent proof at the `@signalai/p2p` layer with fully opaque bytes.
 *
 * MUST use an in-process `@hyperswarm/testnet` bootstrap on every node
 * created here — omitting it falls through to hyperdht's public mainnet DHT,
 * which never resolves in this sandboxed/offline environment (the exact
 * failure mode that stalled a prior attempt for 600s).
 */
describe("createP2pTransport (P0, client-sdk)", () => {
  let testnet: Testnet | undefined;
  let nodes: P2pNodeType[] = [];

  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.destroy()));
    nodes = [];
    await testnet?.destroy();
    testnet = undefined;
  });

  function buildEnvelope(): Envelope {
    return parseEnvelope({
      conversationId: "conv-p0-p2p",
      senderUserId: "user-a",
      senderDeviceId: 1,
      recipientDeviceId: 1,
      seq: 0,
      ciphertext: Buffer.from("opaque-ciphertext-payload").toString("base64"),
      type: 2,
    });
  }

  it("delivers an EnvelopeSchema-shaped frame from A's ClientSocket to B by public key, with no relay", async () => {
    testnet = await createTestnet(3);
    const bNode = createP2pNode({ bootstrap: testnet.bootstrap });
    nodes.push(bNode);

    const keyPair = P2pNode.keyPair();
    const envelope = buildEnvelope();
    const wireFrame = JSON.stringify(envelope);

    // Peer B: a raw @signalai/p2p listener that echoes back whatever bytes it
    // receives — the receiving side of a `MessageTransport` is out of scope
    // for this transport (only `openSocket()` for the dialing side is
    // required by P0), so we exercise it directly here.
    const server = await bNode.listen((socket: P2pSocket) => {
      socket.on("error", () => {});
      socket.on("data", (chunk: Buffer) => socket.write(chunk));
    }, keyPair);

    // Peer A: the transport under test. Dials B directly by public key.
    const transport = createP2pTransport({
      peerPublicKey: keyPair.publicKey,
      nodeOptions: { bootstrap: testnet.bootstrap },
    });

    const received = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("delivery timed out after 15s — no data received (possible DHT bootstrap hang)")),
        15_000,
      );
      const socket: ClientSocket = transport.openSocket();
      socket.onMessage((data) => {
        clearTimeout(timer);
        resolve(data);
      });
      socket.onError((err) => {
        clearTimeout(timer);
        reject(err);
      });
      socket.onOpen(() => socket.send(wireFrame));
    });

    expect(received).toBe(wireFrame);
    const roundTripped = parseEnvelope(JSON.parse(received));
    expect(roundTripped).toEqual(envelope);
    expect(EnvelopeSchema.safeParse(JSON.parse(received)).success).toBe(true);

    await server.close();
  });

  it("queues sends issued before the connection opens and flushes them in order once it does", async () => {
    testnet = await createTestnet(3);
    const bNode = createP2pNode({ bootstrap: testnet.bootstrap });
    nodes.push(bNode);

    const keyPair = P2pNode.keyPair();
    const received: string[] = [];

    const server = await bNode.listen((socket: P2pSocket) => {
      socket.on("error", () => {});
      socket.on("data", (chunk: Buffer) => socket.write(chunk));
    }, keyPair);

    const transport = createP2pTransport({
      peerPublicKey: keyPair.publicKey,
      nodeOptions: { bootstrap: testnet.bootstrap },
    });

    const socket: ClientSocket = transport.openSocket();

    // Sent synchronously, before the underlying duplex has opened — these
    // must land in the replay buffer (`outbox`) rather than being dropped,
    // and flush in order once `onOpen` fires.
    socket.send("frame-1");
    socket.send("frame-2");

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("delivery timed out after 15s — queued frames never arrived")),
        15_000,
      );
      socket.onMessage((data) => {
        received.push(data);
        if (received.length === 2) {
          clearTimeout(timer);
          resolve();
        }
      });
      socket.onError((err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    expect(received).toEqual(["frame-1", "frame-2"]);

    await server.close();
  });
});

/**
 * relayThrough auto-fallback (design §D Risk 1), exercised with an in-process
 * fake `node`/socket rather than a real DHT — hole-punch failure is not
 * reproducible in the offline testnet (loopback peers always connect), so the
 * failure path is driven by emitting `error` on a controllable fake socket.
 */
class FakeSocket extends EventEmitter {
  readonly written: string[] = [];
  destroyed = false;
  write(data: string): boolean {
    this.written.push(data);
    return true;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

class FakeNode {
  readonly dials: Array<{ publicKey: Buffer; opts: P2pDialOptions | undefined }> = [];
  readonly sockets: FakeSocket[] = [];
  dial(publicKey: Buffer, opts?: P2pDialOptions): P2pSocket {
    const socket = new FakeSocket();
    this.dials.push({ publicKey, opts });
    this.sockets.push(socket);
    return socket as unknown as P2pSocket;
  }
}

describe("createP2pTransport relayThrough auto-fallback (fake node)", () => {
  const peerPublicKey = Buffer.from("peer-public-key");
  const relayKey = Buffer.from("relay-peer-key");

  it("relayThrough OFF ⇒ a pre-open dial error surfaces to onError and never re-dials", () => {
    const node = new FakeNode();
    const transport = createP2pTransport({ peerPublicKey, node: node as unknown as P2pNodeType });

    const socket = transport.openSocket();
    const errors: Error[] = [];
    socket.onError((err) => errors.push(err));

    node.sockets[0].emit("error", new Error("direct dial failed"));

    expect(node.dials.length).toBe(1); // no fallback re-dial
    expect(errors.map((e) => e.message)).toEqual(["direct dial failed"]);
  });

  it("relayThrough ON, direct errors ⇒ re-dials through the relay and delivers a pre-swap queued frame once it opens", () => {
    const node = new FakeNode();
    const transport = createP2pTransport({
      peerPublicKey,
      node: node as unknown as P2pNodeType,
      relayThrough: relayKey,
    });

    const socket = transport.openSocket();
    const errors: Error[] = [];
    socket.onError((err) => errors.push(err));

    // Queued before the underlying duplex opens (and before the swap).
    socket.send("frame-before-swap");

    // Direct dial fails before open → triggers the relayThrough fallback.
    node.sockets[0].emit("error", new Error("hole-punch failed"));

    // A SECOND dial was made, through the configured relay peer's key.
    expect(node.dials.length).toBe(2);
    expect(node.dials[1].opts?.relayThrough).toBe(relayKey);
    expect(node.sockets[0].destroyed).toBe(true); // failed direct socket torn down
    expect(errors.length).toBe(0); // the pre-open error was absorbed by the fallback

    // Relay socket opens → outbox flushes onto it (send reads the CURRENT raw).
    node.sockets[1].emit("open");
    expect(node.sockets[1].written).toEqual(["frame-before-swap"]);
  });
});
