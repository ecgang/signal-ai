import { defineConfig } from "vitest/config";

/**
 * Every test file in this package boots a real relay and calls `resetDb()` —
 * a `TRUNCATE ... RESTART IDENTITY CASCADE` — in its setup. Vitest runs test
 * files in parallel workers by default, so two files would truncate each
 * other's rows mid-test (a removed user, a vanished conversation) and fail
 * nondeterministically, hence `fileParallelism: false` — files run one at a
 * time, `it()`s within a file stay ordered by the shared beforeEach(resetDb)
 * lifecycle.
 *
 * `globalSetup` clones this package a PRIVATE database (see
 * `test/globalSetup.ts`) before any worker starts, so this package's
 * TRUNCATEs can never race another package's relay when `pnpm -r run test`
 * runs packages concurrently — see `apps/agent/test/globalSetup.ts` for the
 * full root-cause writeup of the historical cross-package flake.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
    globalSetup: ["./test/globalSetup.ts"],
  },
});
