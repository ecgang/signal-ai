import { WebSocket as NodeWebSocket } from "ws";
import type { PreKeyBundlePublic, ConversationMember } from "@signalai/proto";

/**
 * A thin, mockable duck-type over a WebSocket connection. The real transport
 * wraps the `ws` package; tests could substitute a fake implementation
 * without touching `SignalAiClient`/`DuplexLink`.
 */
export interface ClientSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  ping(): void;
  onOpen(cb: () => void): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: (code: number, reason: string) => void): void;
  onError(cb: (err: Error) => void): void;
}

function wrapNodeSocket(ws: NodeWebSocket): ClientSocket {
  return {
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    ping: () => {
      try {
        ws.ping();
      } catch {
        // socket already closing/closed — a missed keepalive tick is harmless.
      }
    },
    onOpen: (cb) => ws.on("open", cb),
    onMessage: (cb) => ws.on("message", (data: Buffer) => cb(data.toString("utf8"))),
    onClose: (cb) => ws.on("close", (code: number, reason: Buffer) => cb(code, reason.toString("utf8"))),
    onError: (cb) => ws.on("error", cb),
  };
}

/**
 * The message-delivery plane — opening a raw duplex socket. This is the
 * ONLY plane a P2P transport (Plan 002's `transport-p2p.ts`) reimplements:
 * there is no REST `send`, messages/deliveries ride the socket returned
 * here. Kept separate from the central-authority planes below so a P2P
 * impl can satisfy this interface alone without stubbing signup/directory/
 * membership (see docs/design/p2p-transport.md §C).
 */
export interface MessageTransport {
  openSocket(): ClientSocket;
}

/**
 * The prekey/device-directory plane (central authority on the relay; in
 * P2P this becomes DHT-published signed bundles — design open-Q#1, P3).
 */
export interface DirectoryService {
  publishDevice(token: string, userId: string, bundle: PreKeyBundlePublic): Promise<void>;
  fetchBundles(token: string, username: string, deviceId?: number): Promise<PreKeyBundlePublic[]>;
  /** Like {@link fetchBundles} but keyed by the opaque `userId` instead of `username` (`GET /users/by-id/:userId/bundle`) — for callers that only know a peer's userId. */
  fetchBundlesByUserId(token: string, userId: string, deviceId?: number): Promise<PreKeyBundlePublic[]>;
}

/**
 * The account plane — pure central authority (invite codes, usernames,
 * bearer tokens). In P2P there is no signup at all: the public key IS the
 * identity, so this plane is dropped entirely, not reimplemented.
 */
export interface AccountService {
  signup(req: { inviteCode: string; username: string }): Promise<{ userId: string; token: string }>;
}

/**
 * The membership plane (central authority on the relay; in P2P this becomes
 * the founder-signed op-log — Plan 004).
 */
export interface MembershipService {
  createConversation(
    token: string,
    req: { creatorUserId: string; memberUserIds: string[]; aiMode: boolean },
  ): Promise<string>;
  invite(token: string, conversationId: string, userId: string): Promise<void>;
  removeMember(token: string, conversationId: string, userId: string): Promise<void>;
  setAiMode(token: string, conversationId: string, enabled: boolean): Promise<void>;
  listMembers(
    token: string,
    conversationId: string,
  ): Promise<{ members: ConversationMember[]; aiMode: boolean }>;
}

/**
 * Everything `SignalAiClient` needs from "the network" — REST calls plus
 * opening a raw socket. Kept behind an interface for testability.
 *
 * TEMPORARY intersection alias over the four role planes above (P-1,
 * docs/design/p2p-transport.md §C / §D): preserves every existing import of
 * `Transport` while the planes are re-drawn internally. `createHttpWsTransport`
 * is the one concrete impl and satisfies all four planes unchanged.
 */
export type Transport = MessageTransport & DirectoryService & AccountService & MembershipService;

class RelayRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    method: string,
    path: string,
  ) {
    super(`relay request failed: ${method} ${path} -> ${status} ${JSON.stringify(body)}`);
    this.name = "RelayRequestError";
  }
}

async function requestJson(
  baseUrl: string,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<unknown> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await fetch(new URL(path, baseUrl), {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const json: unknown = text.length > 0 ? JSON.parse(text) : undefined;
  if (!res.ok) throw new RelayRequestError(res.status, json, method, path);
  return json;
}

/** The default `Transport`: real HTTP (via global `fetch`) + real WebSocket (via `ws`) against a live relay. */
export function createHttpWsTransport(relayUrl: string): Transport {
  const httpBase = relayUrl.replace(/^ws/, "http");
  const wsBase = relayUrl.replace(/^http/, "ws");

  return {
    async signup(req) {
      const json = (await requestJson(httpBase, "POST", "/signup", { body: req })) as {
        userId: string;
        token: string;
      };
      return json;
    },

    async publishDevice(token, userId, bundle) {
      await requestJson(httpBase, "POST", "/devices", { token, body: { userId, bundle } });
    },

    async fetchBundles(token, username, deviceId) {
      const path = deviceId !== undefined ? `/users/${username}/bundle?deviceId=${deviceId}` : `/users/${username}/bundle`;
      const json = (await requestJson(httpBase, "GET", path, { token })) as { bundles: PreKeyBundlePublic[] };
      return json.bundles;
    },

    async fetchBundlesByUserId(token, userId, deviceId) {
      const path =
        deviceId !== undefined ? `/users/by-id/${userId}/bundle?deviceId=${deviceId}` : `/users/by-id/${userId}/bundle`;
      const json = (await requestJson(httpBase, "GET", path, { token })) as { bundles: PreKeyBundlePublic[] };
      return json.bundles;
    },

    async createConversation(token, req) {
      const json = (await requestJson(httpBase, "POST", "/conversations", { token, body: req })) as {
        conversationId: string;
      };
      return json.conversationId;
    },

    async invite(token, conversationId, userId) {
      await requestJson(httpBase, "POST", `/conversations/${conversationId}/invite`, { token, body: { userId } });
    },

    async removeMember(token, conversationId, userId) {
      await requestJson(httpBase, "POST", `/conversations/${conversationId}/remove`, { token, body: { userId } });
    },

    async setAiMode(token, conversationId, enabled) {
      await requestJson(httpBase, "PATCH", `/conversations/${conversationId}/ai-mode`, { token, body: { enabled } });
    },

    async listMembers(token, conversationId) {
      const json = (await requestJson(httpBase, "GET", `/conversations/${conversationId}/members`, { token })) as {
        members: ConversationMember[];
        aiMode: boolean;
      };
      return { members: json.members, aiMode: json.aiMode };
    },

    openSocket() {
      return wrapNodeSocket(new NodeWebSocket(new URL("/ws", wsBase)));
    },
  };
}
