import { defineConfig } from "vitest/config";

/**
 * Every test file in this package boots a real relay against the SAME shared
 * Postgres (DATABASE_URL, the docker-compose db on :5433) and calls
 * `resetDb()` — a `TRUNCATE ... RESTART IDENTITY CASCADE` — in its setup.
 * Vitest runs test files in parallel workers by default, so two files would
 * truncate each other's rows mid-test (a removed user, a vanished
 * conversation) and fail nondeterministically. There is exactly one physical
 * database, so the test files must run one at a time. `fileParallelism: false`
 * serializes files while still allowing `it()`s within a file to be ordered by
 * the shared beforeEach(resetDb) lifecycle.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
