import {
  WsDeliverFrameSchema,
  WsReadyFrameSchema,
  WsOpDeliverFrameSchema,
  type Envelope,
  type WsSendFrame,
  type WsAckFrame,
  type WsSubscribeFrame,
  type WsOpSendFrame,
  type WsOpDeliverFrame,
} from "@signalai/proto";
import type { ClientSocket, MessageTransport } from "./transport.js";
import type { ConnectionState } from "./types.js";

/** The relay's own connection handshake frame (see apps/relay/src/index.ts) — not part of @signalai/proto's wire union because it's a pure transport concern the relay never forwards. */
interface WsAuthFrame {
  type: "auth";
  token: string;
  deviceId: number;
}

type OutgoingFrame = WsAuthFrame | WsSendFrame | WsAckFrame | WsSubscribeFrame | WsOpSendFrame;

export interface DuplexLinkHandlers {
  onReady: () => void;
  onDeliver: (envelope: Envelope) => void;
  onStateChange: (state: ConnectionState) => void;
  /**
   * Fires on an incoming `op-deliver` frame (Phase A.2) — one membership
   * op propagated by the relay for `conversationId` at chain position `seq`,
   * opaque base64 in `op` (see `WsOpDeliverFrameSchema`). Optional: only
   * `SignalAiClient` wires it (to accumulate + persist the receiver chain);
   * a bare `DuplexLink` consumer that doesn't care about membership ops can
   * omit it.
   */
  onOp?: (frame: WsOpDeliverFrame) => void;
}

/**
 * The mailbox-drain seam, negotiated per link rather than assumed by every
 * link (docs/design/p2p-transport.md §C, Neo lock #3). `onReady` fires once
 * per successful handshake, right after the transport-level `ready` state is
 * reached. The relay path passes {@link NO_OP_DRAIN}: the relay already
 * drains this device's offline mailbox server-side before/at `ready`, so
 * there is nothing for the client to do. A future node/mailbox-backed P2P
 * link (no server-side queue) implements this via a client-side replay
 * buffer request; a direct (mailbox-less) peer connection genuinely has none
 * and also uses {@link NO_OP_DRAIN} — modeled as an explicit no-op, not a
 * faked empty mailbox.
 */
export interface DrainCapability {
  onReady(): void;
}

/** The default drain capability: the relay auto-drains server-side, so there is nothing for the client to trigger. */
export const NO_OP_DRAIN: DrainCapability = {
  onReady: () => {},
};

const INITIAL_BACKOFF_MS = 300;
const MAX_BACKOFF_MS = 10_000;
const KEEPALIVE_MS = 20_000;

/**
 * Maintains one authenticated duplex connection (relay WS today; a P2P
 * duplex stream in a future transport) via {@link MessageTransport.openSocket}:
 * opens the socket, authenticates via the first-frame path
 * (`{type:"auth", token, deviceId}`), waits for `ready`, and auto-reconnects
 * with exponential backoff on any unexpected close. No client-driven polling
 * is needed for delivery on the relay: the relay live-pushes to any open,
 * authenticated recipient socket on `send` (see `apps/relay/src/index.ts`'s
 * `liveSockets` registry) and automatically drains this device's offline
 * mailbox once, right after every `ready` — see {@link DrainCapability} for
 * how that assumption is now an explicit, negotiated seam rather than baked
 * into every link. `subscribe()` (below) is exposed as a manual resync
 * primitive but is not required for normal delivery.
 */
export class DuplexLink {
  private socket: ClientSocket | undefined;
  private closedByUser = false;
  private backoffMs = INITIAL_BACKOFF_MS;
  private keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private ready = false;

  constructor(
    private readonly transport: MessageTransport,
    private readonly token: string,
    private readonly deviceId: number,
    private readonly handlers: DuplexLinkHandlers,
    private readonly drain: DrainCapability = NO_OP_DRAIN,
  ) {}

  /** Opens the socket and resolves once the relay's `ready` frame arrives (rejects if the socket errors/closes first). */
  connect(): Promise<void> {
    this.closedByUser = false;
    return new Promise((resolve, reject) => {
      this.openOnce(resolve, reject);
    });
  }

  private openOnce(onFirstReady?: () => void, onFirstError?: (err: Error) => void): void {
    this.handlers.onStateChange("connecting");
    const socket = this.transport.openSocket();
    this.socket = socket;
    let settled = false;

    socket.onOpen(() => {
      this.rawSend(socket, { type: "auth", token: this.token, deviceId: this.deviceId });
    });

    socket.onMessage((raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }

      const readyFrame = WsReadyFrameSchema.safeParse(parsed);
      if (readyFrame.success) {
        this.ready = true;
        this.backoffMs = INITIAL_BACKOFF_MS;
        this.startKeepalive();
        this.handlers.onStateChange("connected");
        this.drain.onReady();
        this.handlers.onReady();
        if (!settled) {
          settled = true;
          onFirstReady?.();
        }
        return;
      }

      const deliverFrame = WsDeliverFrameSchema.safeParse(parsed);
      if (deliverFrame.success) {
        this.handlers.onDeliver(deliverFrame.data.envelope);
        return;
      }

      const opDeliverFrame = WsOpDeliverFrameSchema.safeParse(parsed);
      if (opDeliverFrame.success) {
        this.handlers.onOp?.(opDeliverFrame.data);
      }
    });

    socket.onError((err) => {
      if (!settled) {
        settled = true;
        onFirstError?.(err);
      }
    });

    socket.onClose(() => {
      const wasReady = this.ready;
      this.ready = false;
      this.stopKeepalive();
      this.handlers.onStateChange("disconnected");
      if (!settled) {
        settled = true;
        onFirstError?.(new Error("socket closed before auth completed"));
      }
      if (!this.closedByUser) this.scheduleReconnect();
      void wasReady; // state already reported above regardless of prior readiness
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.openOnce();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => this.socket?.ping(), KEEPALIVE_MS);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = undefined;
  }

  private rawSend(socket: ClientSocket, frame: OutgoingFrame): void {
    socket.send(JSON.stringify(frame));
  }

  send(frame: WsSendFrame | WsAckFrame | WsOpSendFrame): void {
    if (!this.socket || !this.ready) throw new Error("DuplexLink.send: socket is not connected/ready");
    this.rawSend(this.socket, frame);
  }

  /** Manual resync: pulls this conversation's pending mailbox now. Not needed for normal delivery (the relay already live-pushes to an open socket and auto-drains on `ready`) — exposed for callers that want to force a resync. A no-op if not currently connected/ready. */
  subscribe(conversationId: string): void {
    if (!this.socket || !this.ready) return;
    this.rawSend(this.socket, { type: "subscribe", conversationId });
  }

  get isReady(): boolean {
    return this.ready;
  }

  /** Intentionally closes the connection; no further auto-reconnect happens until `connect()` is called again. */
  disconnect(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopKeepalive();
    this.socket?.close(1000, "client disconnect");
  }
}
