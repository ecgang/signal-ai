import { createPrismaClient } from "@signalai/relay";

/**
 * Runs ONCE before this package's vitest workers start (Vitest `globalSetup`).
 * Mirrors `apps/agent/test/globalSetup.ts` — see that file for the full
 * root-cause writeup of the cross-package DB-collision flake this fixes.
 * `test/helpers.ts`'s `DATABASE_URL` reads `process.env.DATABASE_URL`, so
 * setting it here (before any test file loads) is sufficient — no helper
 * changes needed.
 */
const ADMIN_DATABASE_URL =
  process.env.SIGNALAI_TEST_ADMIN_URL ?? "postgresql://postgres:postgres@localhost:5433/postgres";
const TEMPLATE_DB = "signalai_test";
const PACKAGE_DB = "signalai_test_clientsdk";

export default async function setup(): Promise<void> {
  const admin = createPrismaClient(ADMIN_DATABASE_URL);
  try {
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
