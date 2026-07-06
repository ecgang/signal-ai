import {
  createP2pNode,
  type P2pDialOptions,
  type P2pNode,
  type P2pNodeOptions,
  type P2pSocket,
} from "@signalai/p2p";
import type { DrainCapability } from "./connection.js";
import type { ClientSocket, MessageTransport } from "./transport.js";

/**
 * The second `MessageTransport` implementation (design
 * docs/design/p2p-transport.md §C, §D Phase P0 / plans/002-p0-p2p-transport.md):
 * opens a direct hyperswarm/HyperDHT duplex connection to a known peer by
 * public key instead of a relay WebSocket.
 *
 * P0 no-stub acceptance check (design §C, load-bearing): this file
 * implements `MessageTransport` ALONE. It does not import or implement any
 * of the other three role planes split out in transport.ts (device/prekey
 * directory, account signup, or group membership) — those are out of scope
 * for a connectivity spike (the directory plane becomes DHT-published
 * signed bundles in P3; account/membership move to the founder-signed
 * op-log in P2/004). If a caller needs those, that is a different module's
 * job, not this transport's.
 */

export interface P2pTransportOptions {
  /** The remote peer's identity public key to dial each time `openSocket()` is called. */
  peerPublicKey: Buffer;
  /**
   * The underlying `@signalai/p2p` node to dial through. Supply one built
   * with `bootstrap: testnet.bootstrap` (from `@hyperswarm/testnet`) in
   * every test — omitting a bootstrap falls through to hyperdht's public
   * mainnet DHT, which never resolves in a sandboxed/offline environment.
   * Pass `nodeOptions` instead to have this function construct one for you.
   */
  node?: P2pNode;
  nodeOptions?: P2pNodeOptions;
  /** Forwarded to `P2pNode.dial` on every `openSocket()` call — e.g. `relayThrough` for NAT fallback (design §D Phase P0, Risk 1). Not exercised by the offline test harness. */
  dialOptions?: P2pDialOptions;
}

export interface P2pTransport extends MessageTransport {
  /**
   * Client-side replay/mailbox buffer satisfying `DuplexLink`'s negotiated
   * drain capability (`connection.ts`'s `DrainCapability`, design §C Neo
   * lock #3). A direct hyperswarm peer connection has no server-side inbox
   * to drain: if frames are sent while the peer is unreachable, the only
   * place that backlog can live is the sender's own process. Every frame
   * handed to a `ClientSocket.send()` returned by this transport is queued
   * here until the underlying p2p duplex is open, then flushed in order.
   *
   * Honest caveat, found during P0 and not papered over: `DuplexLink.connect()`
   * (connection.ts:108-121) only calls `drain.onReady()` after parsing a
   * relay-style `{type:"ready"}` JSON frame from the peer — a bare
   * hyperswarm connection never sends one, so wiring this capability
   * through a live `DuplexLink` as-is would stall waiting for a frame that
   * never arrives. That generalization (dropping the relay-specific
   * auth→ready handshake for a p2p link, design §C: "Auth stays in
   * link-establishment, out of the frame protocol") is real follow-up work,
   * not part of this connectivity spike. This transport instead flushes the
   * buffer itself as soon as the underlying duplex reaches `open` (see
   * `openSocket`), so the replay buffer is independently correct and
   * testable now; `drain` is exposed so it can also be driven externally
   * once a p2p-aware handshake exists.
   */
  drain: DrainCapability;
}

/** The default `MessageTransport` for P2P: dial `peerPublicKey` directly on every `openSocket()` call. No directory, no account, no membership — see the module doc above. */
export function createP2pTransport(options: P2pTransportOptions): P2pTransport {
  const node = options.node ?? createP2pNode(options.nodeOptions);
  const outbox: string[] = [];
  let currentSocket: ClientSocket | undefined;

  const drain: DrainCapability = {
    onReady() {
      if (!currentSocket) return;
      flushInto(currentSocket);
    },
  };

  function flushInto(socket: ClientSocket): void {
    while (outbox.length > 0) {
      const frame = outbox.shift();
      if (frame !== undefined) socket.send(frame);
    }
  }

  function openSocket(): ClientSocket {
    const raw: P2pSocket = node.dial(options.peerPublicKey, options.dialOptions);
    let open = false;

    // Tracks `open`/flushes the outbox unconditionally, independent of
    // whether a consumer subscribes via `onOpen` below. Wiring this only
    // inside `onOpen`'s registration (as an earlier version of this file
    // did) meant a consumer that called `send()` without ever subscribing
    // to `onOpen` would queue forever — the raw "open" listener, and hence
    // `open`/the flush, would never fire. Found via
    // `packages/client-sdk/test/transport-p2p.test.ts`'s queue-then-flush
    // test during P0.
    raw.on("open", () => {
      open = true;
      drain.onReady();
    });

    const socket: ClientSocket = {
      send(data) {
        if (open) raw.write(data);
        else outbox.push(data);
      },
      close(_code, _reason) {
        raw.destroy();
      },
      ping() {
        // hyperdht keeps the UDX connection alive itself
        // (`connectionKeepAlive`); there is no application-level ping frame
        // on a raw duplex byte stream, so this is intentionally a no-op.
      },
      onOpen(cb) {
        raw.on("open", cb);
      },
      onMessage(cb) {
        raw.on("data", (chunk: Buffer) => cb(chunk.toString("utf8")));
      },
      onClose(cb) {
        raw.on("close", () => cb(1000, "p2p connection closed"));
      },
      onError(cb) {
        raw.on("error", cb);
      },
    };

    currentSocket = socket;
    return socket;
  }

  return { openSocket, drain };
}
