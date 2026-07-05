import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolved CLI configuration. Everything is env-derived (no secrets are ever
 * baked in) but the whole record is injectable so tests can point the client at
 * an ephemeral relay + a throwaway state dir without touching `process.env`.
 */
export interface CliConfig {
  /** Relay base URL (`SIGNALAI_RELAY_URL`, else the hosted alpha relay). */
  relayUrl: string;
  /** Directory holding one sqlite file per account (`SIGNALAI_STATE_DIR`, else XDG). */
  stateDir: string;
  /** Optional at-rest passphrase (`SIGNALAI_DB_KEY`), mirroring the agent's `AGENT_DB_KEY`. */
  dbKey: string | undefined;
  /** Username of the AI account to invite via `/ai invite` (`SIGNALAI_AI_USERNAME`, overridable by `--ai`). */
  aiUsername: string | undefined;
  /** When true, plaintext bodies may be logged at debug level (never at info) — mirrors the agent's gate. */
  debugPlaintext: boolean;
}

/**
 * XDG state home for per-account sqlite (`$XDG_STATE_HOME/signalai`, else
 * `~/.local/state/signalai`), overridable wholesale by `SIGNALAI_STATE_DIR`.
 */
function defaultStateDir(env: Record<string, string | undefined>): string {
  if (env.SIGNALAI_STATE_DIR) return env.SIGNALAI_STATE_DIR;
  const xdg = env.XDG_STATE_HOME;
  if (xdg && xdg.length > 0) return join(xdg, "signalai");
  return join(homedir(), ".local", "state", "signalai");
}

/** Builds a {@link CliConfig} from the process environment (see the README for the variable list). */
export function loadCliConfig(env: Record<string, string | undefined> = process.env): CliConfig {
  return {
    relayUrl: env.SIGNALAI_RELAY_URL ?? "https://relay-production-fe4c.up.railway.app",
    stateDir: defaultStateDir(env),
    dbKey: env.SIGNALAI_DB_KEY,
    aiUsername: env.SIGNALAI_AI_USERNAME,
    debugPlaintext: env.DEBUG_PLAINTEXT === "1" || env.DEBUG_PLAINTEXT === "true",
  };
}

/** Absolute path to the durable SDK-state db (account/identity/ratchet/resume) for `username`. */
export function accountDbPath(config: CliConfig, username: string): string {
  return join(config.stateDir, `${username}.sqlite`);
}

/** Absolute path to the CLI-local trust db (verified/ai_member/directory) for `username`. */
export function trustDbPath(config: CliConfig, username: string): string {
  return join(config.stateDir, `${username}.trust.sqlite`);
}
