#!/usr/bin/env node
/**
 * chat-cli — a minimal readline chat over @signalai/client-sdk, for manually
 * verifying two (or more) real clients can talk through a real relay.
 *
 * Run it from SOURCE with tsx: this workspace resolves @signalai/* to their
 * TypeScript source (see the repo README's "running from source" note), so
 * there is no compiled standalone entrypoint to run with plain `node`.
 *
 *   pnpm --filter @signalai/tools chat <relayUrl> <inviteCode> <username> [conversationId]
 *     # equivalently, from tools/:  tsx chat-cli.ts <relayUrl> <inviteCode> <username>
 *
 * Two terminals against the same relay. First bring up the db + relay:
 *
 *   docker compose up -d db
 *   INVITE_CODES=LETMEIN pnpm --filter @signalai/relay dev   # listens on http://localhost:8080
 *
 * Then, in two more terminals:
 *
 *   Terminal 1: pnpm --filter @signalai/tools chat http://localhost:8080 LETMEIN alice
 *   Terminal 2: pnpm --filter @signalai/tools chat http://localhost:8080 LETMEIN bob
 *
 * Both sign up and connect, then each is prompted for the OTHER usernames in
 * the chat — so start BOTH terminals before answering that prompt, because each
 * side has to be registered before the other can look up its prekey bundle.
 * This is the SDK's contact-book step (`resolveUser`), the same "add contact"
 * flow a real app runs before a first message; the relay exposes bundle lookup
 * by username, not a userId directory. See the doc comment on `SignalAiClient`
 * in ../packages/client-sdk/src/client.ts for why.
 *
 * After the contacts step each side is asked for a conversation id: leave it
 * blank on the FIRST terminal to CREATE the conversation (its id is printed),
 * then paste that id into the SECOND terminal to JOIN. (You can also pass the
 * id as an optional 4th arg to skip the prompt.)
 */
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { SignalAiClient } from "@signalai/client-sdk";

async function main(): Promise<void> {
  const [relayUrl, inviteCode, username, conversationIdArg] = process.argv.slice(2);
  if (!relayUrl || !inviteCode || !username) {
    console.error("usage: pnpm --filter @signalai/tools chat <relayUrl> <inviteCode> <username> [conversationId]");
    process.exit(1);
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const client = await SignalAiClient.signup({ relayUrl, inviteCode, username });
  console.log(`signed up as "${username}" (userId ${client.userId}), connected.`);

  client.onConnectionChange = (state) => console.log(`[connection: ${state}]`);
  client.onSystemEvent = (event) => console.log(`[event] ${JSON.stringify(event)}`);
  client.onMessage = (message) => {
    console.log(`\n${message.senderUserId}: ${message.text}`);
    rl.prompt();
  };

  const peersRaw = await rl.question("usernames of everyone else in this chat (comma-separated): ");
  const peerUsernames = peersRaw
    .split(",")
    .map((u) => u.trim())
    .filter((u) => u.length > 0 && u !== username);

  const peerUserIds: string[] = [];
  for (const peerUsername of peerUsernames) {
    const { userId } = await client.resolveUser(peerUsername);
    peerUserIds.push(userId);
  }

  // The creator leaves this blank to make a new conversation; the joiner pastes
  // the id the creator printed. (An optional 4th CLI arg pre-fills it.)
  let conversationId = conversationIdArg;
  if (!conversationId) {
    const answer = (await rl.question("conversation id to join (blank to create a new one): ")).trim();
    if (answer.length > 0) {
      conversationId = answer;
    }
  }
  if (!conversationId) {
    conversationId = await client.createConversation(peerUserIds);
    console.log(`created conversation. conversation id: ${conversationId}`);
  } else {
    await client.listMembers(conversationId);
    console.log(`joined conversation ${conversationId}.`);
  }

  console.log("type a message and press enter to send (Ctrl+C to quit).");
  rl.prompt();
  rl.on("line", (line) => {
    if (line.trim().length > 0) {
      void client.send(conversationId!, line).catch((err: unknown) => console.error("send failed:", err));
    }
    rl.prompt();
  });
  rl.on("close", () => {
    client.disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
