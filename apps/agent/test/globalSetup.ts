import { createPrismaClient } from "@signalai/relay";

/**
 * Runs ONCE before this package's vitest workers start (Vitest `globalSetup`).
 *
 * Root cause of the cross-package flake: every relay-booting test package
 * (agent, cli, client-sdk, relay) defaulted `DATABASE_URL` to the SAME
 * physical database (`signalai`, see each package's `test/helpers.ts`).
 * `pnpm -r run test` runs packages concurrently, so one package's
 * `resetDb()` (`TRUNCATE ... RESTART IDENTITY CASCADE`) could wipe rows a
 * DIFFERENT package's in-flight relay request depended on -> intermittent
 * 401s and "socket closed before auth completed", with the failing package
 * changing run to run depending on scheduling.
 *
 * Fix: give this package its own physically separate database, cloned from
 * the already-migrated `signalai_test` template (created by
 * `docker/init-test-db.sql` specifically to keep tests off dev data) via
 * Postgres `CREATE DATABASE ... TEMPLATE`. `resetDb()` in `test/helpers.ts`
 * is unchanged — it now only ever truncates THIS package's private clone.
 * `process.env.DATABASE_URL` is set here, before any test file imports
 * `test/helpers.ts`, so no other test file needs to change.
 */
const ADMIN_DATABASE_URL =
  process.env.SIGNALAI_TEST_ADMIN_URL ?? "postgresql://postgres:postgres@localhost:5433/postgres";
const TEMPLATE_DB = "signalai_test";
const PACKAGE_DB = "signalai_test_agent";

export default async function setup(): Promise<void> {
  const admin = createPrismaClient(ADMIN_DATABASE_URL);
  try {
    // Defensively clear any stray connections so DROP/CREATE (and the
    // TEMPLATE clone, which requires zero connections to its source) never
    // fail on a leftover connection from a previous crashed run.
    await admin.$executeRawUnsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ($1, $2) AND pid <> pg_backend_pid()`,
      PACKAGE_DB,
      TEMPLATE_DB,
    );
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${PACKAGE_DB}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${PACKAGE_DB}" TEMPLATE "${TEMPLATE_DB}"`);
  } finally {
    await admin.$disconnect();
  }
  process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost:5433/${PACKAGE_DB}`;
}
