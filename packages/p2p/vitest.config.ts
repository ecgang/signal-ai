import { defineConfig } from "vitest/config";

/**
 * Every test in this package spins up an in-process `@hyperswarm/testnet` DHT
 * and dials real (loopback) UDP sockets through it. That is normally fast
 * (seconds), but the one failure mode that matters here is catastrophic: a
 * test that forgets to pass `bootstrap: testnet.bootstrap` to a `DHT`/hyperdht
 * node falls through to the PUBLIC internet bootstrap servers, which never
 * resolve in a sandboxed/offline environment — an effectively infinite hang.
 * `testTimeout` bounds that failure mode to a fast, loud test failure instead
 * of a silent multi-minute stall (see docs/design/p2p-transport.md §D Phase
 * P0 and plans/002-p0-p2p-transport.md).
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
