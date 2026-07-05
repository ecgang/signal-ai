import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliConfig } from "../src/config.js";

/**
 * The CLI e2e suite reuses the agent's real-relay harness verbatim (boot a
 * Fastify relay on an ephemeral port against the shared Postgres, plus
 * `bootAgent`/`MockLlmClient` so a real AI member can be exercised with no
 * network or LLM keys). Re-exporting keeps a single source of truth for the
 * relay lifecycle; only the CLI-local config/state-dir plumbing is added here.
 */
export * from "../../agent/test/helpers.js";
export { INTRO_TEXT } from "../../agent/src/index.js";

const stateRoots: string[] = [];

/** A throwaway state dir (one sqlite pair per account lives under it); removed by {@link cleanupStateDirs}. */
export function tmpStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "signalai-cli-"));
  stateRoots.push(dir);
  return dir;
}

/** Removes every temp state dir created during the run (call in `afterAll`). */
export function cleanupStateDirs(): void {
  for (const dir of stateRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A {@link CliConfig} pointed at the ephemeral relay + a fresh throwaway state dir (no `process.env` touched). */
export function makeCliConfig(relayUrl: string, overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    relayUrl,
    stateDir: tmpStateDir(),
    dbKey: undefined,
    aiUsername: undefined,
    debugPlaintext: false,
    ...overrides,
  };
}
