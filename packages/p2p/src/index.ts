// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- ambient hyperdht/@hyperswarm/testnet shim (no upstream types); the reference directive is what propagates it to every @signalai/p2p consumer's program without a per-consumer tsconfig include. See hyperdht.d.ts.
/// <reference path="./hyperdht.d.ts" />
// ^ Pulls the ambient `hyperdht` / `@hyperswarm/testnet` shims into the program
// of ANY package that imports `@signalai/p2p`. Because every consumer reaches
// this file via the `@signalai/p2p` path alias (source resolution), the shim
// travels with it — no downstream tsconfig `include` edit is needed (and the
// transport-AGNOSTIC apps/cli in particular stays untouched).
import DHT from "hyperdht";
import type { DhtBootstrapNode, DhtKeyPair, DhtSocket } from "hyperdht";

/**
 * @signalai/p2p — a thin hyperdht wrapper: peer connectivity by public key,
 * plus DHT-hosted discovery/mutable-record primitives (design
 * docs/design/p2p-transport.md §A, §C). Deals ONLY in pubkeys and opaque
 * byte streams — it MUST depend on neither `@signalai/proto` nor
 * `@signalai/core` (Neo boundary: avoids a dependency cycle and keeps this
 * package swappable/testable independent of the wire format or crypto).
 *
 * CRITICAL for every caller (library code and tests alike): a `P2pNode`
 * without an explicit `bootstrap` falls through to hyperdht's public mainnet
 * bootstrap servers. In a sandboxed/offline environment that lookup NEVER
 * resolves — an effective infinite hang. Tests MUST construct an in-process
 * DHT via `@hyperswarm/testnet`'s `createTestnet()` and pass
 * `bootstrap: testnet.bootstrap` here.
 */

export type P2pBootstrapNode = DhtBootstrapNode;
export type P2pKeyPair = DhtKeyPair;

/** A duplex byte-stream connection to a peer — opaque bytes only, no framing/parsing imposed. Callers own message boundaries. */
export type P2pSocket = DhtSocket;

export interface P2pNodeOptions {
  /**
   * Injectable DHT bootstrap set. Pass `testnet.bootstrap` from
   * `@hyperswarm/testnet` in every test — see the module-level warning
   * above. Omit only for real deployments that intend the public DHT.
   */
  bootstrap?: P2pBootstrapNode[];
  /** This node's own identity keypair. Defaults to a random ephemeral keypair (hyperdht's `defaultKeyPair`). */
  keyPair?: P2pKeyPair;
}

/**
 * Options for {@link P2pNode.dial}. `relayThrough` is hyperdht's NAT-fallback
 * knob (design §D Phase P0, Risk 1 / §E Risk 1): when direct UDP hole-punch
 * fails (symmetric NAT on one or both sides), traffic is relayed through the
 * given peer's public key instead of a direct socket. Real-internet
 * hole-punch failure is NOT exercisable in this sandbox (no outbound public
 * DHT) — this option exists so the config knob is in place for production
 * use; it is not exercised by the offline test harness, where in-process
 * testnet peers are always directly reachable on loopback.
 */
export interface P2pDialOptions {
  relayThrough?: Buffer;
}

export interface P2pServer {
  on(event: "connection", listener: (socket: P2pSocket) => void): void;
  close(): Promise<void>;
}

/** Thin wrapper over a single hyperdht node. */
export class P2pNode {
  private readonly dht: DHT;

  constructor(options: P2pNodeOptions = {}) {
    this.dht = new DHT({
      bootstrap: options.bootstrap,
      keyPair: options.keyPair,
    });
  }

  /** Generates a new identity keypair (hyperdht's `DHT.keyPair`). Pass a 32-byte `seed` for a deterministic keypair (e.g. derived from a libsignal identity key at a higher layer — this package never sees that derivation). */
  static keyPair(seed?: Buffer): P2pKeyPair {
    return DHT.keyPair(seed);
  }

  /** This node's default identity public key — used for `dial`/`listen` when no explicit keyPair is supplied. */
  get publicKey(): Buffer {
    return this.dht.defaultKeyPair.publicKey;
  }

  /**
   * Listens for inbound connections on `keyPair` (defaults to this node's
   * own identity). `onConnection` fires once per accepted peer with a raw
   * duplex byte stream — echoing, framing, and replay buffering are the
   * caller's job (see `@signalai/client-sdk`'s `transport-p2p.ts`).
   */
  async listen(onConnection: (socket: P2pSocket) => void, keyPair?: P2pKeyPair): Promise<P2pServer> {
    const server = this.dht.createServer();
    server.on("connection", onConnection);
    await server.listen(keyPair ?? this.dht.defaultKeyPair);
    return {
      on: (event, listener) => server.on(event, listener),
      close: () => server.close(),
    };
  }

  /**
   * Dials a peer directly by its 32-byte public key — no directory lookup,
   * no relay unless `opts.relayThrough` is set. Returns a duplex byte
   * stream; the ciphertext it carries is never parsed here (design §A: P2P
   * carries opaque `EnvelopeSchema` bytes byte-for-byte).
   */
  dial(publicKey: Buffer, opts: P2pDialOptions = {}): P2pSocket {
    return this.dht.connect(publicKey, opts);
  }

  /** Announces this node as reachable under `topic` (e.g. a group's discovery topic, design §B.3) — resolves once the announce query completes. */
  async announce(topic: Buffer, keyPair?: P2pKeyPair): Promise<void> {
    await this.dht.announce(topic, keyPair ?? this.dht.defaultKeyPair).finished();
  }

  /** Looks up peers announced under `topic`. Returns hyperdht's raw query stream (design §B.1/§B.3 discovery — not consumed by P0). */
  lookup(topic: Buffer) {
    return this.dht.lookup(topic);
  }

  /** Publishes a signed mutable record (e.g. a signed prekey bundle, design §B.1 layer 3 — DHT-published bundle refresh is P3, not P0). */
  mutablePut(keyPair: P2pKeyPair, value: Buffer) {
    return this.dht.mutablePut(keyPair, value);
  }

  /** Reads a signed mutable record by its owning public key. */
  mutableGet(publicKey: Buffer) {
    return this.dht.mutableGet(publicKey);
  }

  /** Tears down this node's DHT socket/state. Always call in test teardown alongside `testnet.destroy()`. */
  async destroy(): Promise<void> {
    await this.dht.destroy();
  }
}

export function createP2pNode(options?: P2pNodeOptions): P2pNode {
  return new P2pNode(options);
}
