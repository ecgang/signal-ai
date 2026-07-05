import { CiphertextMessageType } from "@signalapp/libsignal-client";
import type { Envelope, CiphertextType } from "@signalai/proto";
import { SessionManager, type DeviceAddress } from "./session.js";
import { toBase64, fromBase64 } from "./wire.js";

/** The conversation/sender metadata stamped onto every Envelope a fan-out produces. */
export interface FanoutContext {
  conversationId: string;
  senderUserId: string;
  senderDeviceId: number;
}

function assertEnvelopeCiphertextType(type: number): CiphertextType {
  if (type === CiphertextMessageType.Whisper || type === CiphertextMessageType.PreKey) {
    return type;
  }
  throw new Error(`GroupFanout only supports Whisper/PreKey ciphertexts, got type ${type}`);
}

/**
 * Fans a single plaintext out to many recipient devices as independent
 * pairwise Double Ratchet ciphertexts — one per member's own session with
 * `local`. There is no group key or sender-key ratchet: each recipient's
 * envelope is only ever decryptable from their own pairwise ratchet state
 * with the sender.
 *
 * Bound to one local party's `SessionManager`. Removing a member from a
 * conversation is purely a caller-side decision to stop passing their address
 * into `encryptForMembers` — no key revocation step is needed. A removed
 * member's pairwise session simply stops receiving ciphertext, and because
 * every member's envelope is sealed to that member's own pairwise ratchet, a
 * ciphertext fanned out for one member is not decryptable from any other
 * member's session. Enforcement of "removed ⇒ no delivery" lives in the
 * relay's membership gates (live-push + reconnect drain) — which the removal
 * test exercises directly; this class only decides who to encrypt for.
 */
export class GroupFanout {
  private readonly seq = new Map<string, number>();

  constructor(private readonly local: SessionManager) {}

  private nextSeq(recipient: DeviceAddress): number {
    const key = `${recipient.userId}.${recipient.deviceId}`;
    const value = (this.seq.get(key) ?? 0) + 1;
    this.seq.set(key, value);
    return value;
  }

  /**
   * Encrypts `plaintext` once per member in `memberDeviceAddresses`,
   * returning one Envelope per member in the same order as the input array.
   */
  async encryptForMembers(
    plaintext: Uint8Array,
    memberDeviceAddresses: DeviceAddress[],
    context: FanoutContext,
  ): Promise<Envelope[]> {
    const envelopes: Envelope[] = [];
    for (const member of memberDeviceAddresses) {
      const ciphertext = await this.local.encrypt(member, plaintext);
      envelopes.push({
        conversationId: context.conversationId,
        senderUserId: context.senderUserId,
        senderDeviceId: context.senderDeviceId,
        recipientDeviceId: member.deviceId,
        seq: this.nextSeq(member),
        ciphertext: toBase64(ciphertext.serialize()),
        type: assertEnvelopeCiphertextType(ciphertext.type()),
      });
    }
    return envelopes;
  }

  /** Decrypts an Envelope addressed to this fan-out's local party, using its sender fields to find the session. */
  async decryptEnvelope(envelope: Envelope): Promise<Uint8Array> {
    const sender: DeviceAddress = { userId: envelope.senderUserId, deviceId: envelope.senderDeviceId };
    return this.local.decrypt(sender, envelope.type, fromBase64(envelope.ciphertext));
  }
}
