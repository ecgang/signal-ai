import { createP2pTransport, type P2pTransportOptions } from "./transport-p2p.js";
import { createHttpWsTransport, type Transport } from "./transport.js";

/** Which message-plane transport a client uses. "relay" is the default and only proven path. */
export type TransportMode = "relay" | "p2p";

export interface TransportSelectorParams {
  relayUrl: string;
  /**
   * Message-plane selector. Defaults to "relay". When unset, `SIGNALAI_TRANSPORT=p2p`
   * in the environment flips the default to "p2p" — the single "one flip from live"
   * switch, readable without editing apps/cli. P2P is NOT default until the real-NAT
   * probe passes (packages/p2p/scripts/probe.ts).
   */
  mode?: TransportMode;
  /** Required when the resolved mode is "p2p": the direct-dial peer options (peerPublicKey, optional relayThrough). */
  p2p?: P2pTransportOptions;
}

/** Reads the env default for the transport mode. "p2p" only if SIGNALAI_TRANSPORT === "p2p"; anything else ⇒ "relay". */
export function transportModeFromEnv(env: NodeJS.ProcessEnv = process.env): TransportMode {
  return env.SIGNALAI_TRANSPORT === "p2p" ? "p2p" : "relay";
}

/**
 * Builds the `Transport` for a client. Default-OFF: returns the relay transport unless
 * mode (explicit or env) is "p2p". In "p2p" mode the MESSAGE plane is a direct hyperdht
 * dial while directory/account/membership stay on the relay (design §C: the planes are
 * independent). NOTE (honest scope): this composite is 1:1 (one peerPublicKey) — group
 * fan-out over P2P is not yet wired; that is the post-probe follow-up in plans/002.
 *
 * SECOND honest caveat: this returns a wired-and-tested SEAM, not a proven live loop.
 * `openSocket()` dials correctly (unit-tested), but a live client send/receive through
 * the composite would today stall on first connect — `DuplexLink.connect()` only fires
 * `drain.onReady()` after a relay-style `{type:"ready"}` frame a bare hyperswarm socket
 * never sends (see transport-p2p.ts's `drain` doc). Dropping that relay-specific
 * auth→ready handshake for a p2p link is the remaining wiring, also tracked in plans/002.
 * So the "flip" arms the selector; it does not by itself make a P2P group conversation work.
 */
export function resolveTransport(params: TransportSelectorParams): Transport {
  const relay = createHttpWsTransport(params.relayUrl);
  const mode = params.mode ?? transportModeFromEnv();
  if (mode !== "p2p") return relay;
  if (params.p2p === undefined) {
    throw new Error(
      "resolveTransport: transport mode 'p2p' requires p2p options (peerPublicKey). " +
        "Group fan-out over P2P is not yet wired — see plans/002-p0-p2p-transport.md.",
    );
  }
  const p2p = createP2pTransport(params.p2p);
  // Composite: message plane → P2P; directory/account/membership → relay.
  return { ...relay, openSocket: p2p.openSocket };
}
