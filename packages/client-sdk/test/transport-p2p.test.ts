import { afterEach, describe, expect, it } from "vitest";
import createTestnet, { type Testnet } from "@hyperswarm/testnet";
import { createP2pNode, P2pNode, type P2pNode as P2pNodeType, type P2pSocket } from "@signalai/p2p";
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
