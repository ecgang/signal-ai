import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import type BetterSqlite3 from "better-sqlite3";
import type { SerializedClientStores } from "../stores.js";

type SqliteDatabase = BetterSqlite3.Database;

/**
 * The full durable state one `@signalai/client-sdk` account needs to
 * {@link SignalAiClient.resume} after a restart: the serialized crypto/bookkeeping
 * stores plus the resume scalars. `serializedIdentity.identityKeyPair` is base64
 * (JSON columns hold no raw bytes) — the caller decodes it back to a
 * `Uint8Array` for `resume(...)`.
 */
export interface PersistedClientState {
  token: string;
  userId: string;
  username: string;
  deviceId: number;
  nextOneTimePreKeyId: number;
  serializedIdentity: { identityKeyPair: string; registrationId: number };
  serializedStores: SerializedClientStores;
}

/** One turn in a conversation's rolling context window, shaped for the LLM `complete()` contract. */
export interface ContextMessage {
  role: "user" | "assistant";
  content: string;
  sentAt: number;
}

/** Per-conversation bookkeeping the mode engine persists so restart keeps continuity. */
export interface ConversationMeta {
  /** Whether the one-time intro has already been sent for this conversation. */
  greeted: boolean;
  /** Human messages seen since the agent's last reply here — drives the active-mode cadence cap. */
  humanSinceLastReply: number;
}

/** Trimming bounds for {@link SqliteAgentStore.appendContext}. */
export interface ContextLimits {
  maxMessages: number;
  maxTokens: number;
}

const DEFAULT_META: ConversationMeta = { greeted: false, humanSinceLastReply: 0 };

/** Rough token estimate (no tokenizer dependency): ~4 chars per token, per 5B.5. */
function estimateTokens(messages: ContextMessage[]): number {
  let chars = 0;
  for (const m of messages) chars += m.content.length;
  return Math.ceil(chars / 4);
}

/**
 * Durable SQLite-backed state for a headless client (the phase-5 AI agent, and
 * — reused — the phase-6 human CLI). It does NOT define a new store interface:
 * it round-trips the exact {@link PersistedClientState} blob that
 * `SignalAiClient.resume(...)` consumes, plus the agent's per-conversation
 * rolling context ({@link ContextMessage}) and mode bookkeeping
 * ({@link ConversationMeta}) — each strictly keyed by `conversationId`, which is
 * the physical enforcement of the per-conversation isolation invariant (5B.5).
 *
 * **At-rest encryption:** when an encryption key is provided (`opts.encryptionKey`
 * or `AGENT_DB_KEY`), every JSON payload column is sealed with AES-256-GCM
 * (node stdlib; key = scrypt(passphrase, per-db salt)). No cryptography is
 * invented — only standard-mode primitives. Without a key the payloads are
 * stored as plaintext JSON (disclosed in `apps/agent/SECURITY.md`). The
 * encrypted/plaintext choice is recorded in `store_meta` and re-opening with a
 * mismatched key fails fast rather than corrupting reads.
 */
export class SqliteAgentStore {
  private readonly db: SqliteDatabase;
  private readonly key: Buffer | undefined;

  private constructor(db: SqliteDatabase, key: Buffer | undefined) {
    this.db = db;
    this.key = key;
  }

  /**
   * Opens (creating if absent) the SQLite database at `path` and prepares its
   * schema. `better-sqlite3` is imported lazily so importing this module never
   * forces the native addon to load for callers that don't persist to disk.
   */
  static async open(path: string, opts: { encryptionKey?: string } = {}): Promise<SqliteAgentStore> {
    const Ctor = (await import("better-sqlite3")).default;
    const db = new Ctor(path);
    db.pragma("journal_mode = WAL");
    db.exec(
      `CREATE TABLE IF NOT EXISTS store_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
       CREATE TABLE IF NOT EXISTS client_state (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL);
       CREATE TABLE IF NOT EXISTS context_windows (conversation_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
       CREATE TABLE IF NOT EXISTS conversation_meta (conversation_id TEXT PRIMARY KEY, payload TEXT NOT NULL);`,
    );

    const passphrase = opts.encryptionKey ?? process.env.AGENT_DB_KEY;
    const readMeta = (k: string): string | undefined =>
      (db.prepare("SELECT v FROM store_meta WHERE k = ?").get(k) as { v: string } | undefined)?.v;
    const writeMeta = (k: string, v: string): void => {
      db.prepare("INSERT INTO store_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
    };

    const existingSalt = readMeta("salt");
    let salt: Buffer;
    if (existingSalt === undefined) {
      // Fresh database: record the salt and whether we will encrypt from now on.
      salt = randomBytes(16);
      writeMeta("salt", salt.toString("base64"));
      writeMeta("encrypted", passphrase ? "1" : "0");
    } else {
      salt = Buffer.from(existingSalt, "base64");
      const wasEncrypted = readMeta("encrypted") === "1";
      if (wasEncrypted && !passphrase) {
        db.close();
        throw new Error(
          `SqliteAgentStore: database at ${path} is encrypted at rest — set AGENT_DB_KEY (or pass encryptionKey) to open it`,
        );
      }
      if (!wasEncrypted && passphrase) {
        db.close();
        throw new Error(
          `SqliteAgentStore: database at ${path} was created without at-rest encryption; refusing to open it with a key (existing rows are plaintext). Use a fresh AGENT_DB_PATH to enable encryption.`,
        );
      }
    }

    const key = passphrase ? scryptSync(passphrase, salt, 32) : undefined;
    return new SqliteAgentStore(db, key);
  }

  /** Serializes `value` to a payload string, sealing it with AES-256-GCM when a key is configured. */
  private encode(value: unknown): string {
    const json = JSON.stringify(value);
    if (!this.key) return `raw:${json}`;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const enc = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `enc:${Buffer.concat([iv, tag, enc]).toString("base64")}`;
  }

  /** Inverse of {@link encode}. */
  private decode<T>(payload: string): T {
    if (payload.startsWith("raw:")) return JSON.parse(payload.slice(4)) as T;
    if (payload.startsWith("enc:")) {
      if (!this.key) throw new Error("SqliteAgentStore: encrypted payload but no key configured");
      const buf = Buffer.from(payload.slice(4), "base64");
      const iv = buf.subarray(0, 12);
      const tag = buf.subarray(12, 28);
      const enc = buf.subarray(28);
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAuthTag(tag);
      const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
      return JSON.parse(dec.toString("utf8")) as T;
    }
    throw new Error("SqliteAgentStore: unrecognized payload prefix");
  }

  /** Returns the persisted account state, or `null` if this database has never been saved to. */
  load(): PersistedClientState | null {
    const row = this.db.prepare("SELECT payload FROM client_state WHERE id = 1").get() as
      | { payload: string }
      | undefined;
    if (!row) return null;
    return this.decode<PersistedClientState>(row.payload);
  }

  /** Upserts the single account-state row. */
  save(state: PersistedClientState): void {
    this.db
      .prepare(
        "INSERT INTO client_state (id, payload) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload",
      )
      .run(this.encode(state));
  }

  /** Loads a conversation's rolling context window (empty array if none). */
  loadContext(conversationId: string): ContextMessage[] {
    const row = this.db.prepare("SELECT payload FROM context_windows WHERE conversation_id = ?").get(conversationId) as
      | { payload: string }
      | undefined;
    if (!row) return [];
    return this.decode<ContextMessage[]>(row.payload);
  }

  /** Replaces a conversation's context window wholesale. */
  saveContext(conversationId: string, messages: ContextMessage[]): void {
    this.db
      .prepare(
        "INSERT INTO context_windows (conversation_id, payload) VALUES (?, ?) ON CONFLICT(conversation_id) DO UPDATE SET payload = excluded.payload",
      )
      .run(conversationId, this.encode(messages));
  }

  /**
   * Appends one turn to a conversation's window and trims it to `limits`
   * (oldest-first) by both message count and approximate token budget, then
   * persists. Returns the trimmed window.
   */
  appendContext(conversationId: string, message: ContextMessage, limits: ContextLimits): ContextMessage[] {
    const window = this.loadContext(conversationId);
    window.push(message);
    while (window.length > limits.maxMessages) window.shift();
    while (window.length > 1 && estimateTokens(window) > limits.maxTokens) window.shift();
    this.saveContext(conversationId, window);
    return window;
  }

  /** Removes a conversation's context window AND its mode bookkeeping (self-removal purge, 5B.5). */
  purgeContext(conversationId: string): void {
    this.db.prepare("DELETE FROM context_windows WHERE conversation_id = ?").run(conversationId);
    this.db.prepare("DELETE FROM conversation_meta WHERE conversation_id = ?").run(conversationId);
  }

  /** Loads a conversation's mode bookkeeping, defaulting to un-greeted / zero counter. */
  loadConvMeta(conversationId: string): ConversationMeta {
    const row = this.db
      .prepare("SELECT payload FROM conversation_meta WHERE conversation_id = ?")
      .get(conversationId) as { payload: string } | undefined;
    if (!row) return { ...DEFAULT_META };
    return this.decode<ConversationMeta>(row.payload);
  }

  /** Upserts a conversation's mode bookkeeping. */
  saveConvMeta(conversationId: string, meta: ConversationMeta): void {
    this.db
      .prepare(
        "INSERT INTO conversation_meta (conversation_id, payload) VALUES (?, ?) ON CONFLICT(conversation_id) DO UPDATE SET payload = excluded.payload",
      )
      .run(conversationId, this.encode(meta));
  }

  /** Closes the underlying database handle. */
  close(): void {
    this.db.close();
  }
}
