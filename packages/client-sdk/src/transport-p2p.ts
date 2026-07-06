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
  /**
   * Auto-fallback: if a direct hole-punch doesn't reach `open` within
   * `fallbackTimeoutMs` (or errors first), transparently re-dial the SAME peer
   * through this relay peer's public key (hyperdht `relayThrough`, design §D
   * Risk 1). Default OFF (undefined ⇒ direct-only, no fallback).
   */
  relayThrough?: Buffer;
  /**
   * How long to wait for a direct dial to reach `open` before triggering the
   * `relayThrough` fallback. Default 8000. Ignored when `relayThrough` is unset.
   */
  fallbackTimeoutMs?: number;
}

/** Default {@link P2pTransportOptions.fallbackTimeoutMs}: how long a direct dial gets before the `relayThrough` fallback fires. */
const DEFAULT_FALLBACK_TIMEOUT_MS = 8000;

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
    let open = false;
    let relayAttempted = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    // Consumer callbacks are STORED (not bound directly to `raw`) so they
    // survive a `relayThrough` swap: when a failed direct dial is torn down
    // and re-dialed through the relay, `attach` re-binds these same arrays to
    // the new underlying socket, and `send()`/`close()` read the CURRENT
    // `raw` via the `let` closure — the swap is transparent to the consumer.
    const openCbs: Array<() => void> = [];
    const messageCbs: Array<(data: string) => void> = [];
    const closeCbs: Array<(code: number, reason: string) => void> = [];
    const errorCbs: Array<(err: Error) => void> = [];
    let raw: P2pSocket;

    function clearFallbackTimer(): void {
      if (fallbackTimer !== undefined) {
        clearTimeout(fallbackTimer);
        fallbackTimer = undefined;
      }
    }

    function attach(socket: P2pSocket): void {
      // The "open" handler tracks `open`/flushes the outbox unconditionally,
      // independent of whether a consumer subscribes via `onOpen`. Wiring this
      // only inside `onOpen`'s registration (as an earlier version of this
      // file did) meant a consumer that called `send()` without ever
      // subscribing to `onOpen` would queue forever — the raw "open" listener,
      // and hence `open`/the flush, would never fire. Found via
      // `packages/client-sdk/test/transport-p2p.test.ts`'s queue-then-flush
      // test during P0.
      socket.on("open", () => {
        open = true;
        clearFallbackTimer();
        drain.onReady();
        for (const cb of openCbs) cb();
      });
      socket.on("data", (chunk: Buffer) => {
        const s = chunk.toString("utf8");
        for (const cb of messageCbs) cb(s);
      });
      socket.on("close", () => {
        for (const cb of closeCbs) cb(1000, "p2p connection closed");
      });
      socket.on("error", (err: Error) => {
        // A direct dial that errors before opening is the fallback trigger
        // (alongside the timeout below) — re-dial through the relay ONCE
        // rather than surfacing the failure. With `relayThrough` unset, or
        // after the swap, the error propagates to the consumer as before.
        if (!open && !relayAttempted && options.relayThrough !== undefined) {
          triggerRelayFallback();
          return;
        }
        for (const cb of errorCbs) cb(err);
      });
    }

    function triggerRelayFallback(): void {
      relayAttempted = true;
      clearFallbackTimer();
      try {
        raw.destroy();
      } catch {
        // best-effort teardown of the failed direct socket
      }
      raw = node.dial(options.peerPublicKey, { ...options.dialOptions, relayThrough: options.relayThrough });
      attach(raw);
    }

    raw = node.dial(options.peerPublicKey, options.dialOptions);
    attach(raw);
    if (options.relayThrough !== undefined) {
      fallbackTimer = setTimeout(() => {
        if (!open && !relayAttempted) triggerRelayFallback();
      }, options.fallbackTimeoutMs ?? DEFAULT_FALLBACK_TIMEOUT_MS);
      // Don't keep the event loop alive purely for a fallback timer.
      (fallbackTimer as { unref?: () => void }).unref?.();
    }

    const socket: ClientSocket = {
      send(data) {
        if (open) raw.write(data);
        else outbox.push(data);
      },
      close(_code, _reason) {
        clearFallbackTimer();
        raw.destroy();
      },
      ping() {
        // hyperdht keeps the UDX connection alive itself
        // (`connectionKeepAlive`); there is no application-level ping frame
        // on a raw duplex byte stream, so this is intentionally a no-op.
      },
      onOpen(cb) {
        openCbs.push(cb);
      },
      onMessage(cb) {
        messageCbs.push(cb);
      },
      onClose(cb) {
        closeCbs.push(cb);
      },
      onError(cb) {
        errorCbs.push(cb);
      },
    };

    currentSocket = socket;
    return socket;
  }

  return { openSocket, drain };
}
