import { defineConfig } from "vitest/config";

/**
 * `test/index.test.ts` boots a real relay and calls `resetDb()` in its
 * `beforeEach`. This package previously had no vitest.config.ts (default
 * config), which was harmless in isolation (a single test file) but still
 * left this package sharing the same physical `signalai` database as
 * agent/cli/client-sdk — the root cause of the historical cross-package
 * flake when `pnpm -r run test` runs packages concurrently. `fileParallelism:
 * false` is set for consistency/future-proofing against additional test
 * files, matching the sibling packages.
 *
 * `globalSetup` clones this package a PRIVATE database (see
 * `test/globalSetup.ts`) before any worker starts — see
 * `apps/agent/test/globalSetup.ts` for the full root-cause writeup.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
    globalSetup: ["./test/globalSetup.ts"],
  },
});
