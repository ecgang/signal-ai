import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * `cli.test.ts` boots a real relay and truncates it in `beforeEach`, so —
 * exactly like the client-sdk and agent suites — test files must run one at a
 * time, hence `fileParallelism: false`.
 *
 * `globalSetup` clones this package a PRIVATE database (see
 * `test/globalSetup.ts`) before any worker starts, so this package's
 * TRUNCATEs can never race another package's relay when `pnpm -r run test`
 * runs packages concurrently — see `apps/agent/test/globalSetup.ts` for the
 * full root-cause writeup of the historical cross-package flake.
 *
 * `fs.allow` is widened to the monorepo root because the suite reuses the
 * agent's e2e helpers (`apps/agent/test/helpers.ts` → `bootAgent`) by relative
 * import, per the phase-6b spec's test-harness note.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export default defineConfig({
  test: {
    fileParallelism: false,
    globalSetup: ["./test/globalSetup.ts"],
  },
  server: {
    fs: {
      allow: [repoRoot],
    },
  },
});
