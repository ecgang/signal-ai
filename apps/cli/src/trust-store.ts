import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import type BetterSqlite3 from "better-sqlite3";

type SqliteDatabase = BetterSqlite3.Database;

/**
 * Optional at-rest sealing for the trust store's value columns, byte-for-byte
 * the same scheme {@link SqliteAgentStore} uses (scrypt(passphrase, per-db
 * salt) → AES-256-GCM, `raw:` / `enc:` prefixed payloads) so a single
 * `SIGNALAI_DB_KEY` protects both databases identically. Re-opening an
 * encrypted db without the key (or a plaintext db WITH a key) fails fast rather
 * than corrupting reads.
 */
class Sealer {
  private constructor(private readonly key: Buffer | undefined) {}

  static forDatabase(db: SqliteDatabase, path: string, passphrase: string | undefined): Sealer {
    const readMeta = (k: string): string | undefined =>
      (db.prepare("SELECT v FROM trust_meta WHERE k = ?").get(k) as { v: string } | undefined)?.v;
    const writeMeta = (k: string, v: string): void => {
      db.prepare("INSERT INTO trust_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
    };

    const existingSalt = readMeta("salt");
    let salt: Buffer;
    if (existingSalt === undefined) {
      salt = randomBytes(16);
      writeMeta("salt", salt.toString("base64"));
      writeMeta("encrypted", passphrase ? "1" : "0");
    } else {
      salt = Buffer.from(existingSalt, "base64");
      const wasEncrypted = readMeta("encrypted") === "1";
      if (wasEncrypted && !passphrase) {
        db.close();
        throw new Error(`CliTrustStore: database at ${path} is encrypted at rest — set SIGNALAI_DB_KEY to open it`);
      }
      if (!wasEncrypted && passphrase) {
        db.close();
        throw new Error(
          `CliTrustStore: database at ${path} was created without at-rest encryption; refusing to open it with a key. Use a fresh SIGNALAI_STATE_DIR to enable encryption.`,
        );
      }
    }
    return new Sealer(passphrase ? scryptSync(passphrase, salt, 32) : undefined);
  }

  seal(value: string): string {
    if (!this.key) return `raw:${value}`;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const enc = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `enc:${Buffer.concat([iv, tag, enc]).toString("base64")}`;
  }

  open(payload: string): string {
    if (payload.startsWith("raw:")) return payload.slice(4);
    if (payload.startsWith("enc:")) {
      if (!this.key) throw new Error("CliTrustStore: encrypted payload but no key configured");
      const buf = Buffer.from(payload.slice(4), "base64");
      const iv = buf.subarray(0, 12);
      const tag = buf.subarray(12, 28);
      const enc = buf.subarray(28);
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
    }
    throw new Error("CliTrustStore: unrecognized payload prefix");
  }
}

/**
 * CLI-local trust state the SDK never persists: which peers a user has verified
 * out-of-band, which member of a conversation is the AI, and a userId→username
 * directory (the SDK's in-memory contact book, made durable so names survive a
 * restart and reverse-map `identityKeyChanged` events back to a display name).
 *
 * Keys are opaque relay ids (conversationId/userId) held as plaintext primary
 * keys — never message bodies or private keys — and every lookup is by a known
 * key, never by value, so sealing only the value columns loses no query power.
 * Account private keys live in the (separately sealed) {@link SqliteAgentStore}.
 */
export class CliTrustStore {
  private constructor(
    private readonly db: SqliteDatabase,
    private readonly sealer: Sealer,
  ) {}

  /** Opens (creating if absent) the trust db at `path` and prepares its schema. */
  static async open(path: string, opts: { encryptionKey?: string } = {}): Promise<CliTrustStore> {
    const Ctor = (await import("better-sqlite3")).default;
    const db = new Ctor(path);
    db.pragma("journal_mode = WAL");
    db.exec(
      `CREATE TABLE IF NOT EXISTS trust_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
       CREATE TABLE IF NOT EXISTS verified (conversation_id TEXT NOT NULL, user_id TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY (conversation_id, user_id));
       CREATE TABLE IF NOT EXISTS ai_member (conversation_id TEXT PRIMARY KEY, user_id TEXT NOT NULL);
       CREATE TABLE IF NOT EXISTS directory (user_id TEXT PRIMARY KEY, username TEXT NOT NULL);`,
    );
    const sealer = Sealer.forDatabase(db, path, opts.encryptionKey ?? process.env.SIGNALAI_DB_KEY);
    return new CliTrustStore(db, sealer);
  }

  // --- directory (userId -> username) --------------------------------------

  /** Records/updates the display name for a userId (the durable contact book). */
  setDirectory(userId: string, username: string): void {
    this.db
      .prepare(
        "INSERT INTO directory (user_id, username) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET username = excluded.username",
      )
      .run(userId, this.sealer.seal(username));
  }

  /** Reverse-maps a userId to its known username, or `undefined` if never resolved. */
  getUsername(userId: string): string | undefined {
    const row = this.db.prepare("SELECT username FROM directory WHERE user_id = ?").get(userId) as
      | { username: string }
      | undefined;
    return row ? this.sealer.open(row.username) : undefined;
  }

  // --- ai_member (conversationId -> AI userId) -----------------------------

  /** Marks `userId` as the AI member of `conversationId`. */
  setAiMember(conversationId: string, userId: string): void {
    this.db
      .prepare(
        "INSERT INTO ai_member (conversation_id, user_id) VALUES (?, ?) ON CONFLICT(conversation_id) DO UPDATE SET user_id = excluded.user_id",
      )
      .run(conversationId, this.sealer.seal(userId));
  }

  /** The AI member's userId for a conversation, or `undefined` if none is known. */
  getAiMember(conversationId: string): string | undefined {
    const row = this.db.prepare("SELECT user_id FROM ai_member WHERE conversation_id = ?").get(conversationId) as
      | { user_id: string }
      | undefined;
    return row ? this.sealer.open(row.user_id) : undefined;
  }

  /** Forgets the AI mapping for a conversation (after `/ai remove`). */
  deleteAiMember(conversationId: string): void {
    this.db.prepare("DELETE FROM ai_member WHERE conversation_id = ?").run(conversationId);
  }

  // --- verified (conversationId, userId -> verified fingerprint) -----------

  /** Persists the fingerprint that was verified out-of-band for a member. */
  setVerified(conversationId: string, userId: string, fingerprint: string): void {
    this.db
      .prepare(
        "INSERT INTO verified (conversation_id, user_id, fingerprint) VALUES (?, ?, ?) ON CONFLICT(conversation_id, user_id) DO UPDATE SET fingerprint = excluded.fingerprint",
      )
      .run(conversationId, userId, this.sealer.seal(fingerprint));
  }

  /** The fingerprint recorded at verification time, or `undefined` if unverified. */
  getVerifiedFingerprint(conversationId: string, userId: string): string | undefined {
    const row = this.db
      .prepare("SELECT fingerprint FROM verified WHERE conversation_id = ? AND user_id = ?")
      .get(conversationId, userId) as { fingerprint: string } | undefined;
    return row ? this.sealer.open(row.fingerprint) : undefined;
  }

  /**
   * True only when the member is verified AND their CURRENT fingerprint still
   * matches what was verified — so a silent key rotation never shows a stale ✓.
   */
  isVerified(conversationId: string, userId: string, currentFingerprint: string): boolean {
    const stored = this.getVerifiedFingerprint(conversationId, userId);
    return stored !== undefined && stored === currentFingerprint;
  }

  /** Clears every verified row for a userId (across all conversations) — the reset on `identityKeyChanged`. */
  deleteVerifiedForUser(userId: string): void {
    this.db.prepare("DELETE FROM verified WHERE user_id = ?").run(userId);
  }

  /** Closes the underlying database handle. */
  close(): void {
    this.db.close();
  }
}
