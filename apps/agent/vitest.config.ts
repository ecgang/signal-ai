import { defineConfig } from "vitest/config";

/**
 * `agent.test.ts` boots a real relay against the SAME shared Postgres
 * (DATABASE_URL, the docker-compose db on :5433) and calls `resetDb()` in its
 * `beforeEach`. Vitest parallelizes test *files* by default, so a second file
 * truncating rows mid-test would flake this one. There is exactly one physical
 * database, so files must run one at a time — the same constraint the
 * client-sdk package documents. `it()`s within a file stay ordered by the
 * shared beforeEach(resetDb) lifecycle.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
