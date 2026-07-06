import { afterEach, describe, expect, it } from "vitest";
import createTestnet, { type Testnet } from "@hyperswarm/testnet";
import { createP2pNode, P2pNode, type P2pSocket } from "../src/index.js";

/**
 * P0 connectivity spike (plans/002-p0-p2p-transport.md): prove two peers can
 * exchange opaque ciphertext bytes directly by public key, with no relay in
 * the loop. Bytes are treated as opaque here on purpose — this package never
 * parses `EnvelopeSchema` (design §A/§C); see
 * `packages/client-sdk/test/transport-p2p.test.ts` for the same proof using
 * a realistic `EnvelopeSchema`-shaped ciphertext buffer.
 *
 * MUST use an in-process `@hyperswarm/testnet` bootstrap on every node
 * created here. Without it, `P2pNode` falls through to hyperdht's public
 * mainnet DHT, which never resolves in this sandboxed/offline environment —
 * this is the exact failure mode that stalled a prior attempt for 600s.
 */
describe("p2p two-peer harness (P0)", () => {
  let testnet: Testnet | undefined;
  let nodes: P2pNode[] = [];

  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.destroy()));
    nodes = [];
    await testnet?.destroy();
    testnet = undefined;
  });

  it("delivers opaque ciphertext bytes from A to B by public key, with no relay", async () => {
    testnet = await createTestnet(3);
    const a = createP2pNode({ bootstrap: testnet.bootstrap });
    const b = createP2pNode({ bootstrap: testnet.bootstrap });
    nodes.push(a, b);

    const keyPair = P2pNode.keyPair();
    const payload = Buffer.from("opaque-ciphertext-bytes-30-long", "utf8").subarray(0, 30);
    expect(payload.length).toBe(30);

    // Peer B listens on its own keyPair and echoes back whatever it receives
    // (matching the proven harness pattern — echo, not parse). An explicit
    // no-op "error" listener is required: Node throws an EventEmitter's
    // "error" event as an uncaught exception when nothing is listening, and
    // the client side destroying its socket after the echo triggers a
    // benign ECONNRESET here.
    const server = await b.listen((socket: P2pSocket) => {
      socket.on("error", () => {});
      socket.on("data", (chunk: Buffer) => socket.write(chunk));
    }, keyPair);

    // Peer A dials B directly by public key — no directory lookup, no relay.
    const sock = a.dial(keyPair.publicKey);

    const echoed = await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("delivery timed out after 15s — no data received (possible DHT bootstrap hang)")),
        15_000,
      );
      sock.on("open", () => sock.write(payload));
      sock.on("data", (chunk: Buffer) => {
        clearTimeout(timer);
        resolve(chunk);
      });
      sock.on("error", (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    const bytesMatch = echoed.equals(payload);
    console.log(`RECEIVED_BYTES_MATCH: ${bytesMatch} (${echoed.length} bytes by pubkey, no relay)`);
    expect(bytesMatch).toBe(true);
    expect(echoed.length).toBe(30);

    sock.destroy();
    await server.close();
    console.log("P2P_TESTNET_OK");
  });
});
