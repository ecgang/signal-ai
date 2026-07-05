import { z } from "zod";

/**
 * Wire envelope for a single encrypted message passed through the relay.
 * The relay only ever sees `ciphertext` — plaintext never leaves a client.
 */
export const EnvelopeSchema = z.object({
  threadId: z.string().min(1),
  senderId: z.string().min(1),
  ciphertext: z.instanceof(Uint8Array),
  timestamp: z.number().int().nonnegative(),
});

export type Envelope = z.infer<typeof EnvelopeSchema>;

export function parseEnvelope(data: unknown): Envelope {
  return EnvelopeSchema.parse(data);
}
