import { defineConfig } from "vitest/config";

/**
 * The membership op-log suite is pure in-memory (identities + a scripted op
 * sequence) — no relay, no socket, no database. Tests live under `test/`.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
