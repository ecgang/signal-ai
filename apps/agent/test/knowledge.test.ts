import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VaultKnowledgeSource } from "../src/knowledge.js";

/** Unit tests for the local, on-device vault knowledge retrieval seam. No relay, no network. */

const vaultDirs: string[] = [];

function makeVault(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "signalai-vault-"));
  vaultDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, "utf8");
  }
  return dir;
}

afterEach(() => {
  for (const dir of vaultDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("VaultKnowledgeSource", () => {
  it("returns the matching note's snippet with source = relPath › heading", async () => {
    const root = makeVault({
      "signal-ai.md":
        "# Overview\n\nAn AI-first E2EE messenger built on the Signal protocol.\n\n" +
        "## Phase 5\n\nThe agent gained a durable sqlite store and autonomous self-removal detection.\n",
      "unrelated.md": "# Groceries\n\nEggs, milk, bread.\n",
    });
    const source = new VaultKnowledgeSource({ root });

    const results = await source.retrieve("what happened in phase 5 of the agent", 5);

    expect(results.length).toBeGreaterThan(0);
    const top = results[0]!;
    expect(top.source).toContain("signal-ai.md");
    expect(top.source).toContain("Phase 5");
    expect(top.text).toContain("self-removal");
  });

  it("returns [] for a query with no matching content", async () => {
    const root = makeVault({
      "note.md": "# Topic\n\nSomething entirely different.\n",
    });
    const source = new VaultKnowledgeSource({ root });

    const results = await source.retrieve("zzqxnonexistenttoken wibbleflarp", 5);

    expect(results).toEqual([]);
  });

  it("caps the result count at k", async () => {
    const root = makeVault({
      "note.md":
        "# Alpha\n\nkeyword keyword keyword\n\n" +
        "## Beta\n\nkeyword keyword\n\n" +
        "## Gamma\n\nkeyword\n\n" +
        "## Delta\n\nkeyword keyword keyword keyword\n",
    });
    const source = new VaultKnowledgeSource({ root });

    const results = await source.retrieve("keyword", 2);

    expect(results).toHaveLength(2);
  });

  it("a non-existent root yields [] rather than throwing", async () => {
    const source = new VaultKnowledgeSource({ root: "/definitely/does/not/exist/anywhere" });

    await expect(source.retrieve("anything meaningful", 5)).resolves.toEqual([]);
  });

  it("a query with no usable tokens (all short/stopwords) returns []", async () => {
    const root = makeVault({ "note.md": "# A\n\nsome content here\n" });
    const source = new VaultKnowledgeSource({ root });

    const results = await source.retrieve("the a of", 5);

    expect(results).toEqual([]);
  });

  it("a headless file (no markdown headings) becomes a single chunk", async () => {
    const root = makeVault({ "plain.md": "Just a paragraph about widgets and gadgets, no headings at all.\n" });
    const source = new VaultKnowledgeSource({ root });

    const results = await source.retrieve("widgets gadgets", 5);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.text).toContain("widgets");
  });
});
