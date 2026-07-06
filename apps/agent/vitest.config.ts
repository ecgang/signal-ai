import { defineConfig } from "vitest/config";

/**
 * `agent.test.ts` boots a real relay and calls `resetDb()` in its
 * `beforeEach`. Vitest parallelizes test *files* by default, so a second file
 * truncating rows mid-test would flake this one, hence `fileParallelism:
 * false` — files run one at a time, and `it()`s within a file stay ordered by
 * the shared beforeEach(resetDb) lifecycle.
 *
 * `globalSetup` clones this package a PRIVATE database (see
 * `test/globalSetup.ts`) before any worker starts, so this package's
 * TRUNCATEs can never race another package's relay when `pnpm -r run test`
 * runs packages concurrently — the actual root cause of the historical
 * cross-package flake (agent/cli/client-sdk all defaulted to the same
 * physical `signalai` database).
 */
export default defineConfig({
  test: {
    fileParallelism: false,
    globalSetup: ["./test/globalSetup.ts"],
  },
});
