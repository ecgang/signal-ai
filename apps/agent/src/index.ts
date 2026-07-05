/**
 * Agent app stub. The AI agent is a first-class Signal-protocol member: it
 * gets its own identity and is invited/removed from a thread like any other
 * member. This stub only proves the identity shape and workspace wiring.
 */
export interface AgentIdentity {
  agentId: string;
  displayName: string;
}

export function createAgentIdentity(agentId: string): AgentIdentity {
  return { agentId, displayName: `agent:${agentId}` };
}
