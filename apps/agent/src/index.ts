/**
 * `@signalai/agent` — the AI member. A first-class Signal-protocol member: it
 * signs up / resumes through the SAME public SDK API as a human, is
 * invited/removed like any other member, and persists all state (identity,
 * ratchet, per-conversation context) to SQLite so a restart is seamless.
 */
import { SqliteAgentStore } from "@signalai/client-sdk";
import { SignalAgent, loadAgentConfig } from "./agent.js";
import { selectLlmClient } from "./llm.js";
import { selectKnowledgeSource } from "./knowledge.js";

export * from "./llm.js";
export * from "./agent.js";
export * from "./knowledge.js";

/** Minimal identity descriptor retained from the phase-0 stub (referenced by existing tests). */
export interface AgentIdentity {
  agentId: string;
  displayName: string;
}

export function createAgentIdentity(agentId: string): AgentIdentity {
  return { agentId, displayName: `agent:${agentId}` };
}

/** Wires config → store → LLM → {@link SignalAgent} and boots it (signup or resume). */
export async function startAgent(): Promise<SignalAgent> {
  const config = loadAgentConfig();
  const store = await SqliteAgentStore.open(config.dbPath, config.dbKey ? { encryptionKey: config.dbKey } : {});
  const llm = selectLlmClient();
  const knowledge = selectKnowledgeSource();
  const agent = await SignalAgent.create({ config, store, llm, knowledge });
  await agent.boot();
  return agent;
}

// Long-running entry point: only when executed directly (`tsx src/index.ts`),
// never on import. Process guards keep the member alive across unexpected
// errors (the SDK already auto-reconnects on relay drop).
if (import.meta.url === `file://${process.argv[1]}`) {
  process.on("unhandledRejection", (reason) => {
    console.error(`[agent] unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`);
  });
  process.on("uncaughtException", (err: Error) => {
    console.error(`[agent] uncaughtException: ${err.message}`);
  });
  startAgent()
    .then((agent) => {
      console.log(`[agent] running as userId=${agent.userId}`);
    })
    .catch((err: unknown) => {
      console.error(`[agent] failed to start: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
