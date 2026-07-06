import { z } from "zod";

/**
 * @signalai/proto — the single source of truth for every shape that crosses
 * a process boundary in signal-ai: the encrypted wire envelope, the
 * plaintext message a client encrypts/decrypts, the WebSocket frames
 * exchanged with the relay, and the relay's REST request/response bodies.
 *
 * Nothing here depends on @signalapp/libsignal-client — this package models
 * the wire format, not the cryptography. Other packages import these
 * schemas/types rather than redefining any of these shapes themselves.
 */

// ---------------------------------------------------------------------------
// Envelope: the wire format for a single encrypted message passed through the
// relay. The relay only ever sees `ciphertext` — plaintext never leaves a
// client, and the relay cannot distinguish message content from noise.
// ---------------------------------------------------------------------------

/**
 * Matches @signalapp/libsignal-client's `CiphertextMessageType` numeric
 * values for the two message kinds signal-ai ever puts on the wire: a
 * Double Ratchet message (Whisper = 2) or the first message of a session,
 * which embeds an X3DH/PQXDH handshake (PreKey = 3).
 */
export const CiphertextTypeSchema = z.union([z.literal(2), z.literal(3)]);
export type CiphertextType = z.infer<typeof CiphertextTypeSchema>;

/**
 * A single encrypted message addressed to one recipient device. `seq` is a
 * per-(conversation, recipient device) monotonic counter assigned by the
 * sender for delivery ordering/ack bookkeeping — it is not part of the
 * cryptographic ratchet, which orders itself independently.
 *
 * `ciphertext` is base64-encoded (not a raw Uint8Array) so an Envelope
 * round-trips losslessly through JSON, which every WS frame and REST body
 * in this contract uses.
 */
export const EnvelopeSchema = z.object({
  conversationId: z.string().min(1),
  senderUserId: z.string().min(1),
  senderDeviceId: z.number().int().nonnegative(),
  recipientDeviceId: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
  ciphertext: z.string().min(1),
  type: CiphertextTypeSchema,
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

/** Parses and validates an incoming wire Envelope, throwing on malformed input. */
export function parseEnvelope(data: unknown): Envelope {
  return EnvelopeSchema.parse(data);
}

// ---------------------------------------------------------------------------
// Inner plaintext message: the payload a client encrypts into an Envelope's
// ciphertext, and decrypts back out of one.
// ---------------------------------------------------------------------------

/**
 * An authenticated reference to a membership op-log position (Plan 004,
 * PREREQ-1). `seq` is the log position and `headHash` is the lowercase-hex
 * SHA-256 of the canonical encoding of the op at that position.
 *
 * This rides INSIDE {@link PlaintextMessageSchema} — the ratchet-encrypted,
 * end-to-end authenticated payload — so it inherits libsignal's sender
 * authentication for free. It is NEVER added to the cleartext
 * {@link EnvelopeSchema} envelope, which a node/relay can read and forge.
 */
export const MembershipHeadSchema = z.object({
  seq: z.number().int().nonnegative(),
  headHash: z.string().min(1),
});
export type MembershipHead = z.infer<typeof MembershipHeadSchema>;

/** The plaintext content carried inside a decrypted Envelope. */
export const PlaintextMessageSchema = z.object({
  msgId: z.string().min(1),
  text: z.string(),
  mentions: z.array(z.string()),
  sentAt: z.number().int().nonnegative(),
  /**
   * OPTIONAL on the wire so old ciphertext still parses — but the membership
   * receiver gate treats an ABSENT head as fail-closed REJECT (Plan 004 §6).
   * Optional-parse is not default-accept.
   */
  membershipHead: MembershipHeadSchema.optional(),
});
export type PlaintextMessage = z.infer<typeof PlaintextMessageSchema>;

/** Parses and validates a decrypted plaintext message body. */
export function parsePlaintextMessage(data: unknown): PlaintextMessage {
  return PlaintextMessageSchema.parse(data);
}

// ---------------------------------------------------------------------------
// WebSocket frames exchanged between a client and the relay.
// ---------------------------------------------------------------------------

/** Relay -> client: deliver a single Envelope. */
export const WsDeliverFrameSchema = z.object({
  type: z.literal("deliver"),
  envelope: EnvelopeSchema,
});
export type WsDeliverFrame = z.infer<typeof WsDeliverFrameSchema>;

/**
 * Relay -> client: the socket is authenticated and bound to a device; any
 * subsequently-sent frames will be processed. Emitted once, right after the
 * auth/hello handshake succeeds and before pending envelopes are drained, so
 * a client knows when it is safe to send (and that its token was accepted).
 */
export const WsReadyFrameSchema = z.object({
  type: z.literal("ready"),
});
export type WsReadyFrame = z.infer<typeof WsReadyFrameSchema>;

/** Client -> relay: acknowledge receipt of a delivered Envelope up to `seq`. */
export const WsAckFrameSchema = z.object({
  type: z.literal("ack"),
  conversationId: z.string().min(1),
  seq: z.number().int().nonnegative(),
});
export type WsAckFrame = z.infer<typeof WsAckFrameSchema>;

/** Client -> relay: subscribe to a conversation's deliveries, optionally resuming after `sinceSeq`. */
export const WsSubscribeFrameSchema = z.object({
  type: z.literal("subscribe"),
  conversationId: z.string().min(1),
  sinceSeq: z.number().int().nonnegative().optional(),
});
export type WsSubscribeFrame = z.infer<typeof WsSubscribeFrameSchema>;

/**
 * Client -> relay: submit one encrypted Envelope for delivery.
 *
 * `recipientUserId` is carried here as transport addressing (not inside the
 * Envelope) because device ids are unique only *within* a user, so the relay
 * cannot resolve the destination from `recipientDeviceId` alone. A sender
 * fans a group message out into one send frame per (recipientUserId,
 * recipientDeviceId); it never appears in the encrypted payload.
 */
export const WsSendFrameSchema = z.object({
  type: z.literal("send"),
  recipientUserId: z.string().min(1),
  envelope: EnvelopeSchema,
});
export type WsSendFrame = z.infer<typeof WsSendFrameSchema>;

/** The discriminated union of every WS frame kind, keyed on `type`. */
export const WsFrameSchema = z.discriminatedUnion("type", [
  WsDeliverFrameSchema,
  WsReadyFrameSchema,
  WsAckFrameSchema,
  WsSubscribeFrameSchema,
  WsSendFrameSchema,
]);
export type WsFrame = z.infer<typeof WsFrameSchema>;

/** Parses and validates an incoming WS frame, throwing on an unrecognized/malformed frame. */
export function parseWsFrame(data: unknown): WsFrame {
  return WsFrameSchema.parse(data);
}

// ---------------------------------------------------------------------------
// PreKeyBundle wire shape: the public key material a device publishes so
// peers can start an X3DH/PQXDH session with it. All key material fields
// are base64-encoded serialized libsignal key/record bytes; this package
// never touches the bytes' meaning, only their shape.
// ---------------------------------------------------------------------------

/** The public prekey material for one device, as published to and fetched from the relay. */
export const PreKeyBundlePublicSchema = z.object({
  userId: z.string().min(1),
  deviceId: z.number().int().nonnegative(),
  registrationId: z.number().int().nonnegative(),
  identityKey: z.string().min(1),
  signedPreKeyId: z.number().int().nonnegative(),
  signedPreKeyPublic: z.string().min(1),
  signedPreKeySignature: z.string().min(1),
  preKeyId: z.number().int().nonnegative().optional(),
  preKeyPublic: z.string().min(1).optional(),
  kyberPreKeyId: z.number().int().nonnegative(),
  kyberPreKeyPublic: z.string().min(1),
  kyberPreKeySignature: z.string().min(1),
});
export type PreKeyBundlePublic = z.infer<typeof PreKeyBundlePublicSchema>;

// ---------------------------------------------------------------------------
// Relay REST contract.
// ---------------------------------------------------------------------------

/** POST /signup request: register a new user. */
export const SignupRequestSchema = z.object({
  username: z.string().min(1),
});
export type SignupRequest = z.infer<typeof SignupRequestSchema>;

/** POST /signup response. */
export const SignupResponseSchema = z.object({
  userId: z.string().min(1),
});
export type SignupResponse = z.infer<typeof SignupResponseSchema>;

/** POST /devices request: publish a device's identity + prekey bundle. */
export const PublishDeviceRequestSchema = z.object({
  userId: z.string().min(1),
  bundle: PreKeyBundlePublicSchema,
});
export type PublishDeviceRequest = z.infer<typeof PublishDeviceRequestSchema>;

/** POST /devices response. */
export const PublishDeviceResponseSchema = z.object({
  ok: z.literal(true),
});
export type PublishDeviceResponse = z.infer<typeof PublishDeviceResponseSchema>;

/** GET /prekey-bundle request: fetch the bundle(s) needed to start a session with a user. */
export const FetchPreKeyBundleRequestSchema = z.object({
  userId: z.string().min(1),
  deviceId: z.number().int().nonnegative().optional(),
});
export type FetchPreKeyBundleRequest = z.infer<typeof FetchPreKeyBundleRequestSchema>;

/** GET /prekey-bundle response: one bundle per requested (or every) device. */
export const FetchPreKeyBundleResponseSchema = z.object({
  bundles: z.array(PreKeyBundlePublicSchema),
});
export type FetchPreKeyBundleResponse = z.infer<typeof FetchPreKeyBundleResponseSchema>;

/**
 * POST /conversations request: create a new conversation.
 *
 * `memberUserIds` may be empty: a conversation always includes its creator
 * (added as admin by the relay), so a creator-only conversation is well-formed
 * — this is how the CLI's `/new <name>` starts a thread before anyone is
 * `/invite`d. Members can only ever be added, never omit the creator, so an
 * empty initial list is safe and carries no membership-integrity risk.
 */
export const CreateConversationRequestSchema = z.object({
  creatorUserId: z.string().min(1),
  memberUserIds: z.array(z.string().min(1)),
  aiMode: z.boolean().default(false),
});
export type CreateConversationRequest = z.infer<typeof CreateConversationRequestSchema>;

/** POST /conversations response. */
export const CreateConversationResponseSchema = z.object({
  conversationId: z.string().min(1),
});
export type CreateConversationResponse = z.infer<typeof CreateConversationResponseSchema>;

/** POST /conversations/:id/invite request. */
export const InviteMemberRequestSchema = z.object({
  conversationId: z.string().min(1),
  userId: z.string().min(1),
});
export type InviteMemberRequest = z.infer<typeof InviteMemberRequestSchema>;

/** POST /conversations/:id/remove request. */
export const RemoveMemberRequestSchema = z.object({
  conversationId: z.string().min(1),
  userId: z.string().min(1),
});
export type RemoveMemberRequest = z.infer<typeof RemoveMemberRequestSchema>;

/** Shared response for invite/remove membership mutations. */
export const MutateMemberResponseSchema = z.object({
  ok: z.literal(true),
});
export type MutateMemberResponse = z.infer<typeof MutateMemberResponseSchema>;

/** POST /conversations/:id/ai-mode request: toggle whether the AI participant is active. */
export const SetAiModeRequestSchema = z.object({
  conversationId: z.string().min(1),
  enabled: z.boolean(),
});
export type SetAiModeRequest = z.infer<typeof SetAiModeRequestSchema>;

/** POST /conversations/:id/ai-mode response. */
export const SetAiModeResponseSchema = z.object({
  ok: z.literal(true),
});
export type SetAiModeResponse = z.infer<typeof SetAiModeResponseSchema>;

/** One conversation member and the device ids they currently have registered. */
export const ConversationMemberSchema = z.object({
  userId: z.string().min(1),
  deviceIds: z.array(z.number().int().nonnegative()),
});
export type ConversationMember = z.infer<typeof ConversationMemberSchema>;

/** GET /conversations/:id/members request. */
export const ListMembersRequestSchema = z.object({
  conversationId: z.string().min(1),
});
export type ListMembersRequest = z.infer<typeof ListMembersRequestSchema>;

/** GET /conversations/:id/members response. */
export const ListMembersResponseSchema = z.object({
  members: z.array(ConversationMemberSchema),
  aiMode: z.boolean(),
});
export type ListMembersResponse = z.infer<typeof ListMembersResponseSchema>;
