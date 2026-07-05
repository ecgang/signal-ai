import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * `cli.test.ts` boots a real relay against the SAME shared Postgres
 * (DATABASE_URL, docker-compose db on :5433) and truncates it in `beforeEach`,
 * so — exactly like the client-sdk and agent suites — test files must run one
 * at a time against the single physical database.
 *
 * `fs.allow` is widened to the monorepo root because the suite reuses the
 * agent's e2e helpers (`apps/agent/test/helpers.ts` → `bootAgent`) by relative
 * import, per the phase-6b spec's test-harness note.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export default defineConfig({
  test: {
    fileParallelism: false,
  },
  server: {
    fs: {
      allow: [repoRoot],
    },
  },
});
