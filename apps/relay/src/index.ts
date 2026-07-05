/**
 * Relay app stub. The relay only ever routes opaque ciphertext envelopes
 * and coordinates group membership — it never sees plaintext or key material.
 */
export interface RelayServerOptions {
  port: number;
}

export function createRelayServerOptions(port = 8080): RelayServerOptions {
  return { port };
}
