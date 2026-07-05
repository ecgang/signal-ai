/**
 * Optional, additive, default-OFF local knowledge retrieval for the AI member.
 * The agent depends only on the {@link KnowledgeSource} seam; the concrete
 * implementation ({@link VaultKnowledgeSource}) walks a local markdown vault
 * (e.g. an Obsidian vault) entirely on-device — no network call, no upload —
 * and is selected at boot via {@link selectKnowledgeSource} only when
 * `AGENT_VAULT_PATH` is set. When unset, `selectKnowledgeSource` returns
 * `undefined` and the agent's behavior is byte-for-byte unchanged (see
 * `agent.ts`'s `reply()`).
 */
import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join, relative, extname } from "node:path";

/** One retrieved chunk of local knowledge, ready to be folded into a system prompt. */
export interface KnowledgeSnippet {
  /** Human-readable provenance, e.g. "Projects/signal-ai.md › Phase 5". */
  source: string;
  /** The retrieved text chunk (already truncated to a sane length). */
  text: string;
  /** Higher = more relevant. */
  score: number;
}

/** The seam the agent talks to. Implementations MUST NOT throw for empty/no-match input — return `[]`. */
export interface KnowledgeSource {
  /** Stable identifier, e.g. `"vault"` | `"none"`. */
  readonly kind: string;
  /** Returns up to `k` relevant snippets for a free-text query. Never throws. */
  retrieve(query: string, k: number): Promise<KnowledgeSnippet[]>;
}

/** One chunk of a markdown file: the heading it falls under (or the file's relPath if headless) plus its body. */
interface VaultChunk {
  relPath: string;
  heading: string;
  text: string;
}

const MAX_FILES_SCANNED = 2000;
const MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_REFRESH_MS = 60_000;
const DEFAULT_MAX_SNIPPET_CHARS = 600;

/** Small English stopword set; combined with a length<3 cutoff to keep query tokens meaningful. */
const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "her", "was", "one", "our",
  "out", "day", "get", "has", "him", "his", "how", "man", "new", "now", "see", "two", "way",
  "who", "its", "let", "she", "use", "this", "that", "with", "from", "have", "had", "were",
  "been", "being", "they", "them", "then", "than", "also", "into", "over", "after", "before",
  "about", "when", "what", "which", "where", "while", "some", "more", "most", "such", "only",
  "just", "very", "much", "many", "each", "other", "these", "those", "because", "would",
  "could", "should", "will", "shall", "does", "did",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Summed term-frequency overlap between `tokens` and `text` (whole-word, case-insensitive). Explainable by design. */
function scoreChunk(text: string, tokens: string[]): number {
  const lower = text.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    const matches = lower.match(new RegExp(`\\b${escapeRegExp(token)}\\b`, "g"));
    if (matches) score += matches.length;
  }
  return score;
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars).trimEnd()}…`;
}

/** Splits one markdown file's content into chunks at each heading line; headless files become a single chunk. */
function splitIntoChunks(relPath: string, content: string): VaultChunk[] {
  const headingRe = /^(#{1,6})\s+(.*)$/;
  const chunks: VaultChunk[] = [];
  let heading = relPath; // fallback for content preceding the first heading (or a headless file)
  let buf: string[] = [];

  const flush = (): void => {
    const text = buf.join("\n").trim();
    if (text.length > 0) chunks.push({ relPath, heading, text });
    buf = [];
  };

  for (const line of content.split(/\r?\n/)) {
    const m = headingRe.exec(line);
    if (m) {
      flush();
      heading = (m[2] ?? "").trim() || heading;
    } else {
      buf.push(line);
    }
  }
  flush();
  return chunks;
}

/**
 * Local, on-device knowledge retrieval over a markdown vault (`kind = "vault"`).
 * Builds an in-memory index by walking `root` for `*.md` files (bounded scan:
 * at most {@link MAX_FILES_SCANNED} files, each capped at {@link MAX_FILE_BYTES}),
 * splitting each into heading-delimited chunks. The index is cached and rebuilt
 * lazily — on first `retrieve()` and thereafter whenever `refreshMs` has
 * elapsed — so a running agent picks up vault edits without a restart.
 *
 * Every filesystem operation is wrapped so a single unreadable file, or even a
 * missing/inaccessible `root`, degrades to an empty index (`retrieve` → `[]`)
 * rather than throwing.
 */
export class VaultKnowledgeSource implements KnowledgeSource {
  readonly kind = "vault";
  private readonly root: string;
  private readonly maxSnippetChars: number;
  private readonly refreshMs: number;
  private chunks: VaultChunk[] | undefined;
  private lastBuildAt = 0;

  constructor(opts: { root: string; maxSnippetChars?: number; refreshMs?: number }) {
    this.root = opts.root;
    this.maxSnippetChars = opts.maxSnippetChars ?? DEFAULT_MAX_SNIPPET_CHARS;
    this.refreshMs = opts.refreshMs ?? DEFAULT_REFRESH_MS;
  }

  async retrieve(query: string, k: number): Promise<KnowledgeSnippet[]> {
    const tokens = tokenize(query);
    if (tokens.length === 0 || k <= 0) return [];

    const chunks = this.ensureIndex();
    if (chunks.length === 0) return [];

    const scored: KnowledgeSnippet[] = [];
    for (const chunk of chunks) {
      const score = scoreChunk(chunk.text, tokens);
      if (score > 0) {
        scored.push({
          source: `${chunk.relPath} › ${chunk.heading}`,
          text: truncate(chunk.text, this.maxSnippetChars),
          score,
        });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  private ensureIndex(): VaultChunk[] {
    const now = Date.now();
    if (this.chunks === undefined || now - this.lastBuildAt >= this.refreshMs) {
      this.chunks = this.buildIndex();
      this.lastBuildAt = now;
    }
    return this.chunks;
  }

  /** Bounded, best-effort directory walk. Never throws: an unreadable root/dir/file is simply skipped. */
  private buildIndex(): VaultChunk[] {
    try {
      if (!statSync(this.root).isDirectory()) return [];
    } catch {
      return []; // missing/inaccessible root => empty index, per contract
    }

    const chunks: VaultChunk[] = [];
    let scanned = 0;
    const dirStack: string[] = [this.root];

    while (dirStack.length > 0 && scanned < MAX_FILES_SCANNED) {
      const dir = dirStack.pop();
      if (dir === undefined) break;
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable directory: skip, never fatal
      }
      for (const entry of entries) {
        if (scanned >= MAX_FILES_SCANNED) break;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          dirStack.push(full);
          continue;
        }
        if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".md") continue;
        scanned += 1;
        try {
          if (statSync(full).size > MAX_FILE_BYTES) continue;
          const content = readFileSync(full, "utf8");
          chunks.push(...splitIntoChunks(relative(this.root, full), content));
        } catch {
          continue; // unreadable file: skip, never fatal
        }
      }
    }
    return chunks;
  }
}

function optionalIntFromEnv(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Selects the agent's {@link KnowledgeSource}. Returns a {@link VaultKnowledgeSource}
 * ONLY when `AGENT_VAULT_PATH` is set and non-empty; otherwise `undefined` —
 * the default-OFF seam that keeps this feature fully backward-compatible.
 */
export function selectKnowledgeSource(env: Record<string, string | undefined> = process.env): KnowledgeSource | undefined {
  const root = env.AGENT_VAULT_PATH;
  if (root === undefined || root.trim().length === 0) return undefined;
  return new VaultKnowledgeSource({
    root,
    maxSnippetChars: optionalIntFromEnv(env.AGENT_VAULT_SNIPPET_CHARS),
    // AGENT_VAULT_TOP_K is read by loadAgentConfig into AgentConfig.knowledgeTopK,
    // the actual `k` passed to retrieve() at reply time; not needed here.
  });
}
