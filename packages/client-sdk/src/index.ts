/**
 * @signalai/client-sdk — a headless client for the signal-ai relay. No
 * cryptography is implemented here: every encrypt/decrypt/session operation
 * delegates to `@signalai/core`. This package adds the relay REST+WS
 * transport, connection lifecycle (auto-reconnect/keepalive), a contacts
 * directory bridging the relay's username-keyed bundle lookup to its
 * userId-keyed everything-else, conversation/membership caching, and
 * message send/receive/dedupe on top of that.
 */
export * from "./types.js";
export * from "./stores.js";
export * from "./transport.js";
export * from "./connection.js";
export * from "./client.js";
