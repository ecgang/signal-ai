/**
 * Node configuration, read once from process.env at startup. Local dev
 * defaults match docker-compose.yml at the repo root so `docker compose up
 * -d db` + `pnpm --filter @signalai/node dev` works with zero setup.
 */
export interface RelayConfig {
  port: number;
  databaseUrl: string;
  /** Static list of invite codes gating signup. Small, rotated by hand. */
  inviteCodes: string[];
  nodeEnv: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const port = env.PORT ? Number(env.PORT) : 8080;
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid PORT: ${env.PORT}`);
  }

  const databaseUrl = env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/signalai";

  const inviteCodes = (env.INVITE_CODES ?? "")
    .split(",")
    .map((code) => code.trim())
    .filter((code) => code.length > 0);

  return {
    port,
    databaseUrl,
    inviteCodes,
    nodeEnv: env.NODE_ENV ?? "development",
  };
}
