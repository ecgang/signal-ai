import type { PreKeyBundlePublic, ConversationMember } from "@signalai/proto";

/** Connection lifecycle states surfaced via {@link SignalAiClientHandlers.onConnectionChange}. */
export type ConnectionState = "connecting" | "connected" | "disconnected";

/**
 * One conversation member's device, enriched with client-local knowledge the
 * relay itself never returns (the relay's {@link ConversationMember} only
 * carries `userId` + `deviceIds`). `identityKeyFingerprint` is a short sha256
 * hex of the peer's identity public key as known to *this* client's identity
 * store — empty until a session/bundle for that device has been seen.
 * `joinedAt`/`role` are locally-tracked approximations (see stores.ts) since
 * the relay does not expose per-member join time or role beyond membership
 * rows this client cannot otherwise read.
 */
export interface Member {
  userId: string;
  deviceId: number;
  identityKeyFingerprint: string;
  joinedAt: number;
  role: "admin" | "member";
}

/** A decrypted, deduped message delivered to the application via {@link SignalAiClientHandlers.onMessage}. */
export interface IncomingMessage {
  conversationId: string;
  senderUserId: string;
  senderDeviceId: number;
  text: string;
  mentions: string[];
  sentAt: number;
  msgId: string;
}

/**
 * Membership/state changes the SDK can observe given the relay's contract.
 * `aiModeChanged` only fires for *this* client's own successful
 * {@link SignalAiClient.setAiMode} calls — the relay has no endpoint to read
 * back another client's ai-mode toggle, so cross-client observation isn't
 * possible without polling infrastructure the relay doesn't support.
 * `memberLeft` is part of the variant surface for forward-compatibility but
 * is never emitted today: the relay only models admin-initiated removal
 * (`memberRemoved`), not voluntary self-removal.
 */
export type SystemEvent =
  | { type: "memberJoined"; conversationId: string; userId: string; deviceId: number }
  | { type: "memberLeft"; conversationId: string; userId: string }
  | { type: "memberRemoved"; conversationId: string; userId: string }
  | { type: "aiModeChanged"; conversationId: string; enabled: boolean }
  | { type: "identityKeyChanged"; userId: string; deviceId: number };

export interface SignalAiClientHandlers {
  onMessage?: (message: IncomingMessage) => void;
  onSystemEvent?: (event: SystemEvent) => void;
  onConnectionChange?: (state: ConnectionState) => void;
}

export type { PreKeyBundlePublic, ConversationMember };
