#!/usr/bin/env node
/**
 * `signalai` — the thin readline adapter over {@link CliApp}. It contains NO
 * conversation logic: it parses onboarding argv, boots a {@link CliSession},
 * then loops reading a line → `app.handleInput(line)` → print, and subscribes
 * to the app's output sink to print async events. Everything testable lives in
 * `app.ts`; this file exists only to move bytes to and from the terminal.
 *
 * Runnable two ways (the workspace resolves `@signalai/*` to TS source):
 *   dev:   tsx src/main.ts signup --invite LETMEIN --username alice
 *   built: signalai signup --invite LETMEIN --username alice   (bin → dist/main.js)
 */
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadCliConfig, type CliConfig } from "./config.js";
import { signupSession, loginSession, type CliSession } from "./session.js";
import { CliApp } from "./app.js";
import type { RenderedLine } from "./render.js";

interface ParsedArgs {
  command: string | undefined;
  flags: Map<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  // pnpm forwards the `--` separator (`pnpm … dev -- signup …`) through as a
  // literal argv token, which would otherwise be read as the subcommand and
  // print usage. Drop a single leading `--` so the real subcommand is seen.
  const cleaned = argv[0] === "--" ? argv.slice(1) : argv;
  const [command, ...rest] = cleaned;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token?.startsWith("--")) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, "true");
      }
    }
  }
  return { command, flags };
}

/** Applies `--relay` / `--ai` / `--state-dir` overrides onto the env-derived config. */
function configFromFlags(flags: Map<string, string>): CliConfig {
  const config = loadCliConfig();
  const relay = flags.get("relay");
  const ai = flags.get("ai");
  const stateDir = flags.get("state-dir");
  return {
    ...config,
    relayUrl: relay ?? config.relayUrl,
    aiUsername: ai ?? config.aiUsername,
    stateDir: stateDir ?? config.stateDir,
  };
}

function usage(): void {
  console.error("usage:");
  console.error("  signalai signup --invite <code> --username <name> [--relay <url>] [--ai <aiUsername>]");
  console.error("  signalai login --username <name> [--relay <url>] [--ai <aiUsername>]");
}

async function bootFromArgs(args: ParsedArgs): Promise<{ session: CliSession; config: CliConfig }> {
  const config = configFromFlags(args.flags);
  if (args.command === "signup") {
    const invite = args.flags.get("invite");
    const username = args.flags.get("username");
    if (!invite || invite === "true" || !username || username === "true") {
      usage();
      process.exit(1);
    }
    const session = await signupSession({ config, username, inviteCode: invite });
    console.log(`signed up as "${username}" (userId ${session.client.userId}).`);
    return { session, config };
  }
  if (args.command === "login") {
    const username = args.flags.get("username");
    if (!username || username === "true") {
      usage();
      process.exit(1);
    }
    const session = await loginSession({ config, username });
    console.log(`logged in as "${username}" (userId ${session.client.userId}).`);
    return { session, config };
  }
  usage();
  process.exit(1);
}

function print(lines: readonly RenderedLine[]): void {
  for (const l of lines) console.log(l.text);
}

/**
 * The original readline shell — retained verbatim as the non-TTY fallback (tests,
 * pipes, CI) since Ink requires a TTY. In this path readline echoes typed input
 * AND the app re-renders it, so a sent message appears twice; the TUI path fixes
 * that by giving input its own box. Do not delete: it is the headless code path.
 */
async function runReadline(session: CliSession, app: CliApp): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  app.setSink((lines) => print(lines));

  console.log("connected. type /help for commands, /quit to exit.");
  let running = true;
  rl.on("SIGINT", () => {
    running = false;
    rl.close();
  });

  while (running) {
    let input: string;
    try {
      input = await rl.question("> ");
    } catch {
      break; // readline closed
    }
    const trimmed = input.trim();
    print(await app.handleInput(trimmed));
    if (trimmed === "/quit") break;
  }

  rl.close();
  await session.close();
  process.exit(0);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { session, config } = await bootFromArgs(args);
  const app = CliApp.fromSession(session, config);

  // Ink needs a real TTY on BOTH ends; otherwise fall back to the readline shell.
  if (stdout.isTTY && stdin.isTTY) {
    const { runTui } = await import("./tui.js");
    await runTui(session, config, app);
    // The TUI resolves only after it has closed the session and scheduled exit.
    return;
  }

  await runReadline(session, app);
}

// Only run when executed directly (never on import — keeps the module importable by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
