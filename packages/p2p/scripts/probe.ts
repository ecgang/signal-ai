/**
 * Real-internet two-peer P2P connectivity probe (plans/002 step 6 — "Record
 * the NAT reality"; design docs/design/p2p-transport.md Risk 1 / §E Risk 1).
 *
 * This is the piece the offline `two-peer.test.ts` CANNOT be: it runs against
 * hyperdht's PUBLIC MAINNET DHT (no `bootstrap` injected), so it actually
 * exercises UDP hole-punch between two machines on different NATs. The test
 * harness proves the code is correct on an in-process fake DHT; this proves the
 * network works. A `FAIL` here is as valuable as a `SUCCESS` — it tells you to
 * build the `relayThrough` fallback BEFORE wiring P2P into any app.
 *
 * It deals only in pubkeys and opaque bytes (same contract as the package):
 * no proto, no crypto, no EnvelopeSchema parsing.
 *
 * ── Usage (run from repo root; tsx is a root devDep) ─────────────────────────
 *   Machine A (listener):
 *     node_modules/.bin/tsx packages/p2p/scripts/probe.ts listen --seed <hex64>
 *       → prints  LISTENING_PUBKEY: <hex64>   (send this to machine B)
 *
 *   Machine B (dialer):
 *     node_modules/.bin/tsx packages/p2p/scripts/probe.ts dial <pubkey-hex64>
 *       → SUCCESS  (bytes echoed back over a direct connection) or FAIL
 *
 *   Optional flags:
 *     --seed <hex64>       deterministic identity keypair (listener; pick one
 *                          and share the derived pubkey out-of-band with B)
 *     --relay <pubkey-hex> dialer only: force hyperdht's relayThrough NAT
 *                          fallback via this peer (test the symmetric-NAT path)
 *     --bytes <n>          opaque payload size, default 512
 *     --timeout <ms>       give up after this long, default 20000
 *     --bootstrap h:p,h:p  override the DHT bootstrap set (default = mainnet).
 *                          Point both machines at a shared node for a private
 *                          smoke test; OMIT for the real-internet reality check.
 *
 * Exit code 0 = SUCCESS, 1 = FAIL — so this doubles as a falsifiable sensor
 * (e.g. a /goal verifier command). The listener runs until SIGINT (Ctrl-C).
 */
import {
  createP2pNode,
  P2pNode,
  type P2pBootstrapNode,
  type P2pDialOptions,
  type P2pSocket,
} from "../src/index.js";

interface ProbeFlags {
  seed?: Buffer;
  relay?: Buffer;
  bytes: number;
  timeoutMs: number;
  bootstrap?: P2pBootstrapNode[];
}

/** Parse a 32-byte hex value or exit with a clear message. */
function hex32(label: string, value: string): Buffer {
  const buf = Buffer.from(value, "hex");
  if (buf.length !== 32) {
    fail(`${label} must be 32 bytes of hex (got ${buf.length}) — value: ${value}`);
  }
  return buf;
}

function parseBootstrap(value: string): P2pBootstrapNode[] {
  return value.split(",").map((entry) => {
    const [host, port] = entry.split(":");
    if (!host || !port || Number.isNaN(Number(port))) {
      fail(`--bootstrap entry "${entry}" must be host:port`);
    }
    return { host, port: Number(port) } as P2pBootstrapNode;
  });
}

function parseFlags(args: string[]): ProbeFlags {
  const flags: ProbeFlags = { bytes: 512, timeoutMs: 20_000 };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const val = args[i + 1];
    if (val === undefined) fail(`flag ${key} needs a value`);
    switch (key) {
      case "--seed":
        flags.seed = hex32("--seed", val);
        break;
      case "--relay":
        flags.relay = hex32("--relay", val);
        break;
      case "--bytes":
        flags.bytes = Number(val);
        if (!Number.isInteger(flags.bytes) || flags.bytes <= 0) fail("--bytes must be a positive integer");
        break;
      case "--timeout":
        flags.timeoutMs = Number(val);
        if (!Number.isInteger(flags.timeoutMs) || flags.timeoutMs <= 0) fail("--timeout must be a positive integer (ms)");
        break;
      case "--bootstrap":
        flags.bootstrap = parseBootstrap(val);
        break;
      default:
        fail(`unknown flag: ${key}`);
    }
  }
  return flags;
}

/** A deterministic, non-random opaque payload so both sides agree byte-for-byte. */
function makePayload(size: number): Buffer {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = i % 251; // prime stride, avoids all-zero runs
  return buf;
}

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

async function runListener(flags: ProbeFlags): Promise<void> {
  const keyPair = flags.seed ? P2pNode.keyPair(flags.seed) : P2pNode.keyPair();
  const node = createP2pNode({ bootstrap: flags.bootstrap, keyPair });

  // Echo whatever bytes arrive — never parse them (opaque contract). The
  // no-op "error" listener mirrors two-peer.test.ts: hyperdht emits a benign
  // ECONNRESET when the dialer tears down after its echo.
  const server = await node.listen((socket: P2pSocket) => {
    console.log("PEER_CONNECTED");
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => socket.write(chunk));
  }, keyPair);

  const network = flags.bootstrap ? "custom-bootstrap" : "public-mainnet-DHT";
  console.log(`LISTENING_PUBKEY: ${keyPair.publicKey.toString("hex")}`);
  console.log(`NETWORK: ${network} — send the pubkey above to the dialer. Ctrl-C to stop.`);

  const shutdown = async (): Promise<void> => {
    await server.close();
    await node.destroy();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

async function runDialer(peerHex: string, flags: ProbeFlags): Promise<void> {
  const peer = hex32("peer public key", peerHex);
  const node = createP2pNode({ bootstrap: flags.bootstrap });
  const payload = makePayload(flags.bytes);
  const relayRequested = flags.relay !== undefined;
  const dialOpts: P2pDialOptions = flags.relay ? { relayThrough: flags.relay } : {};

  const network = flags.bootstrap ? "custom-bootstrap" : "public-mainnet-DHT";
  console.log(`DIALING: ${peerHex} via ${network} (relayThrough: ${relayRequested ? "yes" : "no"}, ${flags.bytes} bytes)`);

  const dialStart = Date.now();
  const sock = node.dial(peer, dialOpts);
  let openLatencyMs = -1;

  const result = await new Promise<{ ok: boolean; reason?: string; rttMs?: number }>((resolve) => {
    const timer = setTimeout(
      () => resolve({ ok: false, reason: `no echo within ${flags.timeoutMs}ms — likely NAT hole-punch failure (try --relay) or DHT bootstrap hang` }),
      flags.timeoutMs,
    );
    let sentAt = 0;
    sock.on("open", () => {
      openLatencyMs = Date.now() - dialStart;
      console.log(`CONNECTION_OPEN: ${openLatencyMs}ms`);
      sentAt = Date.now();
      sock.write(payload);
    });
    sock.on("data", (chunk: Buffer) => {
      clearTimeout(timer);
      resolve({ ok: chunk.equals(payload), rttMs: Date.now() - sentAt, reason: chunk.equals(payload) ? undefined : `echo mismatch (${chunk.length} of ${payload.length} bytes)` });
    });
    sock.on("error", (err: Error) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: `socket error: ${err.message}` });
    });
  });

  sock.destroy();
  await node.destroy();

  if (result.ok) {
    // relayThrough NOT requested + SUCCESS ⇒ a direct UDP hole-punch worked.
    console.log(`SUCCESS: opaque bytes round-tripped by pubkey. handshake=${openLatencyMs}ms echo_rtt=${result.rttMs}ms direct=${relayRequested ? "no(relayed)" : "yes"}`);
    console.log("P2P_REAL_NAT_OK");
    process.exit(0);
  }
  fail(result.reason ?? "unknown failure");
}

async function main(): Promise<void> {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === "listen") {
    await runListener(parseFlags(rest));
  } else if (mode === "dial") {
    const [peerHex, ...flagArgs] = rest;
    if (!peerHex) fail("dial mode needs a peer pubkey: dial <pubkey-hex64>");
    await runDialer(peerHex, parseFlags(flagArgs));
  } else {
    fail(`usage: probe.ts listen|dial [args] — got "${mode ?? "(none)"}". See the header comment for full usage.`);
  }
}

void main();
