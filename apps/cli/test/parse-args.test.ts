import { describe, it, expect } from "vitest";
import { parseArgs } from "../src/main.js";

/**
 * Regression coverage for the onboarding argv parser. The load-bearing case is
 * the leading `--` strip: `pnpm … dev -- signup …` forwards `--` as a literal
 * argv token, which — before the fix at main.ts:29 — was read as the subcommand
 * and printed usage instead of signing up. These tests pin that behavior so the
 * onboarding path can't silently regress.
 */
describe("parseArgs", () => {
  it("strips a single leading `--` so the real subcommand is seen (the pnpm-forwarding fix)", () => {
    const args = parseArgs(["--", "signup", "--invite", "LETMEIN", "--username", "alice"]);
    expect(args.command).toBe("signup");
    expect(args.flags.get("invite")).toBe("LETMEIN");
    expect(args.flags.get("username")).toBe("alice");
  });

  it("leaves argv untouched when there is no leading `--`", () => {
    const args = parseArgs(["login", "--username", "bob"]);
    expect(args.command).toBe("login");
    expect(args.flags.get("username")).toBe("bob");
  });

  it("strips only ONE leading `--` (a second `--` becomes the command)", () => {
    const args = parseArgs(["--", "--", "signup"]);
    expect(args.command).toBe("--");
  });

  it("treats a flag with no following value as boolean \"true\"", () => {
    const args = parseArgs(["signup", "--invite"]);
    expect(args.flags.get("invite")).toBe("true");
  });

  it("treats a flag immediately followed by another flag as boolean \"true\"", () => {
    const args = parseArgs(["signup", "--invite", "--username", "alice"]);
    expect(args.flags.get("invite")).toBe("true");
    expect(args.flags.get("username")).toBe("alice");
  });

  it("returns an undefined command for empty argv", () => {
    const args = parseArgs([]);
    expect(args.command).toBeUndefined();
    expect(args.flags.size).toBe(0);
  });

  it("returns an undefined command when argv is just a lone `--`", () => {
    const args = parseArgs(["--"]);
    expect(args.command).toBeUndefined();
  });
});
