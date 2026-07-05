import { generateIdentity, type GeneratedIdentity } from "@signalai/core";
import { EnvelopeSchema, type Envelope } from "@signalai/proto";

export interface ClientConfig {
  relayUrl: string;
}

/**
 * Thin client-side handle around a relay connection. Full session/crypto
 * state management is layered in during the protocol-integration phase; for
 * now this stub proves the workspace wiring (core + proto) resolves and
 * that a client can hold a real Signal-protocol identity.
 */
export class SignalAiClient {
  private readonly identity: GeneratedIdentity;

  constructor(private readonly config: ClientConfig) {
    this.identity = generateIdentity();
  }

  get relayUrl(): string {
    return this.config.relayUrl;
  }

  get registrationId(): number {
    return this.identity.registrationId;
  }

  parseIncomingEnvelope(data: unknown): Envelope {
    return EnvelopeSchema.parse(data);
  }
}
