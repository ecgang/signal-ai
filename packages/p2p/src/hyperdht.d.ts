/**
 * Minimal ambient types for `hyperdht` and `@hyperswarm/testnet` — neither
 * package ships TypeScript declarations. Scoped to exactly the surface
 * `./index.ts` and this package's tests use; not a full API mirror.
 *
 * Must stay a standalone script file (no top-level `import`/`export` outside
 * the `declare module` blocks): once a file has top-level module syntax, TS
 * treats a `declare module "x"` inside it as an *augmentation* of an
 * existing module rather than a fresh ambient declaration, and augmenting an
 * untyped module fails with TS2665 ("cannot be augmented").
 *
 * A sibling `.d.ts` is NOT auto-pulled into a downstream program (unlike
 * `index.ts`, which is reached via the `@signalai/p2p` import). So instead of
 * making every consumer add this path to its own `tsconfig.json` `include`
 * (fragile — one new consumer package = one more forgotten edit, and the
 * transport-AGNOSTIC apps/cli must not be touched at all), `./index.ts` carries
 * a `/// <reference path="./hyperdht.d.ts" />` triple-slash directive at its
 * top. Reference directives travel WITH the referencing file into every
 * program that pulls it in, so any package importing `@signalai/p2p` gets these
 * ambient shims automatically — no per-consumer tsconfig edit required.
 */
declare module "hyperdht" {
  import type { Duplex } from "node:stream";

  export interface DhtKeyPair {
    publicKey: Buffer;
    secretKey: Buffer;
  }

  export interface DhtBootstrapNode {
    host: string;
    port: number;
  }

  export interface DhtNodeOptions {
    bootstrap?: DhtBootstrapNode[];
    keyPair?: DhtKeyPair;
    ephemeral?: boolean;
    firewalled?: boolean;
    port?: number;
    host?: string;
    seed?: Buffer;
  }

  export interface DhtConnectOptions {
    keyPair?: DhtKeyPair;
    relayThrough?: Buffer;
  }

  export interface DhtSocket extends Duplex {
    readonly publicKey: Buffer;
    readonly remotePublicKey: Buffer;
  }

  export interface DhtServer {
    listen(keyPair?: DhtKeyPair): Promise<void>;
    close(): Promise<void>;
    refresh(): void;
    address(): unknown;
    on(event: "connection", listener: (socket: DhtSocket) => void): void;
    on(event: "listening" | "close", listener: () => void): void;
  }

  export interface DhtQueryStream {
    finished(): Promise<void>;
    destroy(): void;
  }

  export interface MutablePutResult {
    publicKey: Buffer;
    closestNodes: unknown[];
    seq: number;
    signature: Buffer;
  }

  export interface MutableGetResult {
    value: Buffer;
    from: unknown;
    seq: number;
    signature: Buffer;
  }

  export default class DHT {
    constructor(opts?: DhtNodeOptions);
    readonly defaultKeyPair: DhtKeyPair;
    static keyPair(seed?: Buffer): DhtKeyPair;
    connect(remotePublicKey: Buffer, opts?: DhtConnectOptions): DhtSocket;
    createServer(
      opts?: Record<string, unknown>,
      onconnection?: (socket: DhtSocket) => void,
    ): DhtServer;
    lookup(topic: Buffer, opts?: Record<string, unknown>): DhtQueryStream;
    announce(
      topic: Buffer,
      keyPair?: DhtKeyPair,
      relayAddresses?: unknown[],
      opts?: Record<string, unknown>,
    ): DhtQueryStream;
    unannounce(topic: Buffer, keyPair?: DhtKeyPair, opts?: Record<string, unknown>): Promise<void>;
    mutablePut(
      keyPair: DhtKeyPair,
      value: Buffer,
      opts?: Record<string, unknown>,
    ): Promise<MutablePutResult>;
    mutableGet(publicKey: Buffer, opts?: Record<string, unknown>): Promise<MutableGetResult>;
    destroy(opts?: { force?: boolean }): Promise<void>;
    fullyBootstrapped(): Promise<void>;
  }
}

declare module "@hyperswarm/testnet" {
  import type DHT from "hyperdht";
  import type { DhtBootstrapNode } from "hyperdht";

  export interface Testnet {
    nodes: DHT[];
    bootstrap: DhtBootstrapNode[];
    createNode(opts?: Record<string, unknown>): DHT;
    destroy(): Promise<void>;
  }

  export default function createTestnet(
    size?: number,
    opts?: Record<string, unknown>,
  ): Promise<Testnet>;
}
