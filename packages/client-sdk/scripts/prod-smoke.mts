/**
 * v0.1 alpha PROD smoke — drives the *hosted* relay + the deployed AI member
 * end to end and writes a real transcript to `docs/alpha-smoke-transcript.md`.
 *
 * It is a standalone script (NOT a test — never picked up by vitest) because it
 * needs live prod + real invite codes + a real LLM call. No secrets are
 * embedded: the relay's invite codes are read from the environment.
 *
 * Run (invite codes injected from the relay service; values never printed):
 *   railway run -s relay -- pnpm --filter @signalai/client-sdk exec tsx scripts/prod-smoke.mts
 *
 * Proves, against prod:
 *   1. two humans exchange messages E2EE (bob decrypts alice's plaintext),
 *   2. the AI member gives a GENUINE LLM reply when @mentioned (not its canned
 *      intro, not its LLM-unavailable degrade line),
 *   3. aiMode toggles active and emits aiModeChanged,
 *   4. removing the AI emits memberRemoved to EVERY human, and
 *   5. after removal the AI produces NO further reply (transport revocation).
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SignalAiClient } from "../src/index.js";

const RELAY = process.env.SMOKE_RELAY_URL ?? "https://relay-production-fe4c.up.railway.app";
const AI = process.env.AGENT_USERNAME ?? "ai";
const codes = (process.env.INVITE_CODES ?? process.env.INVITE_CODE ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (codes.length === 0) {
  console.error("FATAL: no INVITE_CODES / INVITE_CODE in env (run under `railway run -s relay -- ...`)");
  process.exit(2);
}
const codeA = codes[0]!;
const codeB = codes.length > 1 ? codes[1]! : codes[0]!;

const stamp = (): string => new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";
const T: string[] = [];
const log = (s: string): void => {
  const line = `[${stamp()}] ${s}`;
  console.log(line);
  T.push(line);
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error(`timeout after ${ms}ms waiting for: ${what}`);
    await sleep(300);
  }
}
const uniq = (p: string): string => `${p}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const isCanned = (t: string): boolean =>
  t.includes("only read messages in threads I'm invited to") || t.includes("having trouble responding");
const short = (id: string): string => id.slice(0, 8);

async function main(): Promise<void> {
  log(`RELAY = ${RELAY}`);
  log(`AI member handle = @${AI}`);

  const alice = await SignalAiClient.signup({ relayUrl: RELAY, inviteCode: codeA, username: uniq("smoke-alice") });
  log(`alice signed up (userId ${short(alice.userId)})`);
  const bob = await SignalAiClient.signup({ relayUrl: RELAY, inviteCode: codeB, username: uniq("smoke-bob") });
  log(`bob   signed up (userId ${short(bob.userId)})`);

  const aliceMsgs: string[] = [];
  const bobMsgs: string[] = [];
  const aliceEvents: { type: string; userId?: string; enabled?: boolean }[] = [];
  const bobEvents: { type: string; userId?: string }[] = [];
  let aiReplies = 0;

  const { userId: aiUserId } = await alice.resolveUser(AI);
  log(`resolved AI member "${AI}" → userId ${short(aiUserId)}`);
  // Resolve bob's bundle before sending (autoResolveMembersById is OFF by
  // design — the sender must know each recipient; the CLI does this in /invite).
  await alice.resolveUser(bob.username);
  log(`resolved bob → ${short(bob.userId)} (prekey bundle cached for fan-out)`);

  alice.onMessage = (m): void => {
    aliceMsgs.push(m.text);
    if (m.senderUserId === aiUserId && !isCanned(m.text)) {
      aiReplies++;
      log(`@ai → alice: "${m.text.slice(0, 220).replace(/\s+/g, " ")}"`);
    }
  };
  bob.onMessage = (m): void => {
    bobMsgs.push(m.text);
  };
  alice.onSystemEvent = (e): void => {
    aliceEvents.push(e as never);
  };
  bob.onSystemEvent = (e): void => {
    bobEvents.push(e as never);
  };

  const conv = await alice.createConversation([]);
  log(`alice created conversation ${short(conv)}`);
  await alice.invite(conv, bob.userId);
  log(`alice invited bob`);
  await alice.invite(conv, aiUserId);
  log(`alice invited @ai`);

  await waitUntil(async () => (await alice.listMembers(conv)).length >= 3, 25_000, "3 members present");
  const members = await alice.listMembers(conv);
  log(`members (${members.length}): ${members.map((m) => short(m.userId)).join(", ")}`);

  // (1)+(2) human↔human E2EE + genuine @ai reply
  const Q = "@ai in one sentence, what does Signal's Double Ratchet give you?";
  await alice.send(conv, Q, [aiUserId]);
  log(`alice → all: "${Q}"`);
  await waitUntil(() => bobMsgs.includes(Q), 15_000, "bob decrypts alice's message");
  log(`bob received alice's plaintext → human↔human E2EE OK`);
  await waitUntil(() => aiReplies >= 1, 60_000, "a GENUINE @ai reply (not intro/degrade)");
  log(`GENUINE @ai reply received (real LLM, not canned)`);

  // (3) aiMode toggle
  await alice.setAiMode(conv, true);
  await waitUntil(
    () => aliceEvents.some((e) => e.type === "aiModeChanged" && e.enabled === true),
    5_000,
    "aiModeChanged(enabled=true)",
  );
  log(`aiMode → active (getAiMode=${alice.getAiMode(conv)}); aiModeChanged(true) observed`);
  await alice.setAiMode(conv, false);
  log(`aiMode → passive (restored)`);

  // (4) removal emits memberRemoved to every human
  const repliesBeforeRemoval = aiReplies;
  await alice.removeMember(conv, aiUserId);
  await alice.listMembers(conv);
  await bob.listMembers(conv);
  await waitUntil(
    () => aliceEvents.some((e) => e.type === "memberRemoved" && e.userId === aiUserId),
    15_000,
    "alice sees memberRemoved(@ai)",
  );
  await waitUntil(
    () => bobEvents.some((e) => e.type === "memberRemoved" && e.userId === aiUserId),
    15_000,
    "bob sees memberRemoved(@ai)",
  );
  log(`@ai removed — memberRemoved(@ai) observed on BOTH alice and bob`);

  // (5) transport revocation: mention @ai after removal → no reply
  await alice.send(conv, "@ai are you still receiving our messages?", [aiUserId]);
  log(`alice → all (post-removal): "@ai are you still receiving our messages?"`);
  log(`waiting 20s to prove @ai produces NO post-removal reply...`);
  await sleep(20_000);
  if (aiReplies !== repliesBeforeRemoval) {
    throw new Error(`REVOCATION FAILED: @ai replied after removal (${repliesBeforeRemoval} → ${aiReplies})`);
  }
  log(`REVOCATION PROVEN: @ai replies before=${repliesBeforeRemoval}, after=${aiReplies} (silent after removal)`);

  alice.disconnect();
  bob.disconnect();

  const __dir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(__dir, "../../..");
  const out = [
    "# signal-ai — v0.1 alpha prod smoke transcript",
    "",
    "> Real end-to-end run against the **hosted** relay and the **deployed** AI",
    "> member. Regenerate with the command below (invite codes are injected from",
    "> the relay service's env — no secret values appear here or in the script).",
    "",
    "```",
    "railway run -s relay -- pnpm --filter @signalai/client-sdk exec tsx scripts/prod-smoke.mts",
    "```",
    "",
    `- **Relay:** ${RELAY}`,
    `- **AI member:** @${AI} (NVIDIA NIM Nemotron \`nvidia/llama-3.3-nemotron-super-49b-v1\`)`,
    `- **Captured:** ${stamp()}`,
    "",
    "It proves, in order: two humans exchange E2EE messages; the AI member gives a",
    "genuine LLM reply when @mentioned; `aiMode` toggles active; removing the AI",
    "emits `memberRemoved` to every human; and after removal the AI produces **no**",
    "further reply (transport-layer revocation).",
    "",
    "```text",
    ...T,
    "```",
    "",
    "**RESULT: ALPHA_SMOKE_PASSED**",
    "",
  ].join("\n");
  writeFileSync(join(repoRoot, "docs/alpha-smoke-transcript.md"), out);
  console.log("\n================ wrote docs/alpha-smoke-transcript.md ================");
  console.log("ALPHA_SMOKE_PASSED");
}

main().catch((err: unknown) => {
  console.error("ALPHA_SMOKE_FAILED:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
