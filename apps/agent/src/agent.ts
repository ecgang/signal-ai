import {
  SignalAiClient,
  InMemoryClientStores,
  SqliteAgentStore,
  type ContextLimits,
  type PersistedClientState,
  type SerializedClientStores,
  type IncomingMessage,
  type SystemEvent,
  type Member,
} from "@signalai/client-sdk";
import { DEFAULT_SYSTEM_PROMPT, type LlmClient } from "./llm.js";
import type { KnowledgeSnippet, KnowledgeSource } from "./knowledge.js";

/** The exact intro sent once per conversation the agent finds itself a member of (5B.3). */
export const INTRO_TEXT =
  "I'm the AI member of this chat. I only read messages in threads I'm invited to. Mode: passive — mention @ai to reach me.";

/** The single polite message sent when the LLM is unavailable (5B.6). */
export const DEGRADE_TEXT = "I'm having trouble responding right now — I'll be back shortly.";

/** At most one degradation apology per conversation per this window. */
const DEGRADE_COOLDOWN_MS = 30_000;

/**
 * Builds the system-prompt suffix that folds retrieved local-knowledge
 * snippets in. Reconciles with {@link DEFAULT_SYSTEM_PROMPT}'s "do not claim
 * to see anything outside this conversation" clause by framing the notes as
 * an on-device background reference, never as chat content. Exported so
 * tests can assert on the exact wording.
 */
export function KNOWLEDGE_BLOCK(snippets: KnowledgeSnippet[]): string {
  const body = snippets.map((s) => `[${s.source}]\n${s.text}\n\n`).join("");
  return (
    "\n\nYou also have access to the operator's private local knowledge notes, retrieved on-device " +
    "(they never leave this machine). Use them as background reference only when relevant, and mention " +
    "the note name if you rely on one. They are not messages in this chat.\n\n" +
    `<knowledge>\n${body}</knowledge>`
  );
}

/** Resolved agent configuration (env-derived, but injectable for tests). */
export interface AgentConfig {
  relayUrl: string;
  username: string;
  inviteCode: string;
  /** Case-insensitive mention handle, default `@ai`. */
  handle: string;
  /** Human messages that must pass between two unprompted active-mode replies (default 5). */
  activeCapN: number;
  contextMaxMessages: number;
  contextMaxTokens: number;
  /** Interval (ms) between autonomous membership-reconciliation sweeps; 0 disables the timer. */
  reconcileIntervalMs: number;
  dbPath: string;
  dbKey: string | undefined;
  systemPrompt: string;
  /** When true, plaintext bodies may be logged at debug level (never at info). */
  debugPlaintext: boolean;
  /** Max local-knowledge snippets folded into the system prompt per reply (default 4; see `AGENT_VAULT_TOP_K`). */
  knowledgeTopK: number;
}

function intFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Builds an {@link AgentConfig} from the process environment (see 5B.2 for the variable list). */
export function loadAgentConfig(env: Record<string, string | undefined> = process.env): AgentConfig {
  return {
    relayUrl: env.RELAY_URL ?? "http://127.0.0.1:8080",
    username: env.AGENT_USERNAME ?? "ai",
    inviteCode: env.INVITE_CODE ?? "",
    handle: env.AGENT_HANDLE ?? "@ai",
    activeCapN: intFromEnv(env.AGENT_ACTIVE_CAP_N, 5),
    contextMaxMessages: intFromEnv(env.AGENT_CONTEXT_MAX_MESSAGES, 50),
    contextMaxTokens: intFromEnv(env.AGENT_CONTEXT_MAX_TOKENS, 8000),
    reconcileIntervalMs: intFromEnv(env.AGENT_RECONCILE_INTERVAL_MS, 30_000),
    dbPath: env.AGENT_DB_PATH ?? "./agent-state.sqlite",
    dbKey: env.AGENT_DB_KEY,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    debugPlaintext: env.DEBUG_PLAINTEXT === "1" || env.DEBUG_PLAINTEXT === "true",
    knowledgeTopK: intFromEnv(env.AGENT_VAULT_TOP_K, 4),
  };
}

/**
 * The AI member: a long-running, headless {@link SignalAiClient} wrapper that
 * signs up (or resumes) exactly like a human, greets conversations once, and
 * replies under a passive/active mode engine — all state (identity, ratchet,
 * per-conversation context, mode counters) durably persisted to
 * {@link SqliteAgentStore} after every mutation so a restart loses neither the
 * ratchet nor conversational continuity.
 *
 * **Concurrency:** inbound messages and system events are serialized through a
 * single promise chain ({@link enqueue}) so the mode counters and the
 * "greeted-once" flag never race.
 *
 * **Isolation invariant (5B.5):** the reply path loads ONLY the triggering
 * conversation's window from the store (keyed by conversationId), so the
 * transcript handed to the LLM for conversation A can contain zero content
 * from conversation B.
 */
export class SignalAgent {
  private readonly config: AgentConfig;
  private readonly store: SqliteAgentStore;
  private readonly llm: LlmClient;
  private readonly knowledge: KnowledgeSource | undefined;
  private client!: SignalAiClient;
  private queue: Promise<void> = Promise.resolve();
  private reconcileTimer: ReturnType<typeof setInterval> | undefined;
  private readonly lastDegradeAt = new Map<string, number>();

  private constructor(config: AgentConfig, store: SqliteAgentStore, llm: LlmClient, knowledge: KnowledgeSource | undefined) {
    this.config = config;
    this.store = store;
    this.llm = llm;
    this.knowledge = knowledge;
  }

  /**
   * Constructs an agent from injected dependencies; call {@link boot} to connect.
   * `knowledge` is optional and additive — omitting it (the default) preserves
   * pre-existing behavior byte-for-byte.
   */
  static async create(deps: {
    config: AgentConfig;
    store: SqliteAgentStore;
    llm: LlmClient;
    knowledge?: KnowledgeSource;
  }): Promise<SignalAgent> {
    return new SignalAgent(deps.config, deps.store, deps.llm, deps.knowledge);
  }

  /** The agent's relay userId (valid after {@link boot}). */
  get userId(): string {
    return this.client.userId;
  }

  /** The underlying SDK client — exposed for tests to drive mode/removal and inspect delivery. */
  get signalClient(): SignalAiClient {
    return this.client;
  }

  /**
   * Signs up a fresh account (persisting immediately) or resumes an existing
   * one from the SQLite store, wires the message/event handlers, and reconciles
   * every already-known conversation (sending any missing intro).
   */
  async boot(): Promise<void> {
    const persisted = this.store.load();
    if (persisted) {
      this.client = await SignalAiClient.resume({
        relayUrl: this.config.relayUrl,
        token: persisted.token,
        userId: persisted.userId,
        username: persisted.username,
        deviceId: persisted.deviceId,
        serializedIdentity: {
          identityKeyPair: Buffer.from(persisted.serializedIdentity.identityKeyPair, "base64"),
          registrationId: persisted.serializedIdentity.registrationId,
        },
        serializedStores: persisted.serializedStores,
        nextOneTimePreKeyId: persisted.nextOneTimePreKeyId,
        autoResolveMembersById: true,
      });
    } else {
      this.client = await SignalAiClient.signup({
        relayUrl: this.config.relayUrl,
        inviteCode: this.config.inviteCode,
        username: this.config.username,
        autoResolveMembersById: true,
      });
      this.persist();
    }

    // TODO(phase-8): handlers are attached AFTER resume/signup, both of which
    // connect() internally, so an inbound message arriving in the connect→wire
    // window has no handler. Attaching handlers before connect requires an SDK
    // signature change to resume/signup (out of scope for this task) — deferred.
    this.client.onMessage = (m) => {
      void this.enqueue(() => this.onMessage(m));
    };
    this.client.onSystemEvent = (e) => {
      void this.enqueue(() => this.onSystemEvent(e));
    };

    await this.enqueue(() => this.reconcileAll());
    this.startReconcileSweep();
  }

  /**
   * Autonomous self-removal detection (5B.5): a live process receives no
   * further messages once removed, and the SDK suppresses `memberRemoved` for
   * the client's OWN removal — so without this sweep a removed agent would only
   * discover its removal on a full restart. Each tick enqueues a reconcile of
   * every known conversation (reusing the serialized queue, never bypassing
   * it); a removed conversation yields a 403/absence → {@link handleSelfRemoval}
   * purges it and drops it from the cache, so it is not swept again (no 403
   * spam). `reconcileIntervalMs <= 0` disables the timer entirely. `.unref()`
   * ensures the timer never keeps the process alive on its own.
   */
  private startReconcileSweep(): void {
    if (this.config.reconcileIntervalMs <= 0) return;
    this.reconcileTimer = setInterval(() => {
      for (const conversationId of [...this.client.stores.conversations.keys()]) {
        void this.enqueue(() => this.reconcileConversation(conversationId));
      }
    }, this.config.reconcileIntervalMs);
    this.reconcileTimer.unref();
  }

  /** Disconnects from the relay and closes the durable store. */
  async shutdown(): Promise<void> {
    if (this.reconcileTimer !== undefined) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = undefined;
    }
    await this.queue.catch(() => undefined);
    this.client.disconnect();
    this.store.close();
  }

  /** Re-checks membership for a conversation (public so operators/tests can force a reconcile, e.g. after a removal). */
  async reconcile(conversationId: string): Promise<void> {
    await this.enqueue(() => this.reconcileConversation(conversationId));
  }

  // --- internals ----------------------------------------------------------

  /** Serializes a task onto the single processing chain; the chain survives task failures. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private ctxOpts(): ContextLimits {
    return { maxMessages: this.config.contextMaxMessages, maxTokens: this.config.contextMaxTokens };
  }

  private async reconcileAll(): Promise<void> {
    for (const conversationId of [...this.client.stores.conversations.keys()]) {
      await this.reconcileConversation(conversationId);
    }
  }

  /**
   * Refreshes membership for one conversation: a `403/forbidden` from the relay
   * (or absence from the returned member list) means the agent is no longer an
   * active member — treated as self-removal. Otherwise, sends the one-time intro.
   */
  private async reconcileConversation(conversationId: string): Promise<void> {
    let members: Member[];
    try {
      members = await this.client.listMembers(conversationId);
    } catch (err) {
      if (this.isForbidden(err)) {
        await this.handleSelfRemoval(conversationId);
      } else {
        this.logError(`listMembers(${conversationId}) failed`, err);
      }
      return;
    }
    if (!members.some((m) => m.userId === this.client.userId)) {
      await this.handleSelfRemoval(conversationId);
      return;
    }
    await this.maybeSendIntro(conversationId);
  }

  private isForbidden(err: unknown): boolean {
    return err instanceof Error && (/-> 403\b/.test(err.message) || err.message.includes("forbidden"));
  }

  /** Sends the intro exactly once per conversation, persisting the greeted flag. */
  private async maybeSendIntro(conversationId: string): Promise<void> {
    const meta = this.store.loadConvMeta(conversationId);
    if (meta.greeted) return;
    await this.client.send(conversationId, INTRO_TEXT);
    meta.greeted = true;
    this.store.saveConvMeta(conversationId, meta);
    this.persist();
  }

  private async onMessage(m: IncomingMessage): Promise<void> {
    if (m.senderUserId === this.client.userId) return; // never react to our own traffic — closes the reply loop

    await this.reconcileConversation(m.conversationId); // ensures membership + one-time intro

    const conv = this.client.stores.conversations.get(m.conversationId);
    if (!conv || !conv.members.has(this.client.userId)) return; // removed / not a member — ignore

    this.logPlaintext(`recv ${m.conversationId} <${m.senderUserId}>: ${m.text}`);
    this.store.appendContext(m.conversationId, { role: "user", content: m.text, sentAt: m.sentAt }, this.ctxOpts());

    const meta = this.store.loadConvMeta(m.conversationId);
    meta.humanSinceLastReply += 1;
    this.store.saveConvMeta(m.conversationId, meta);

    const mentioned = this.isMentioned(m);
    const active = conv.aiMode === true;
    // Passive: reply only when mentioned. Active: reply when mentioned OR the
    // unprompted cadence cap has elapsed. A mention always answers (and reply()
    // resets the counter), so a directly-addressed message is never rate-limited.
    const shouldReply = mentioned || (active && meta.humanSinceLastReply >= this.config.activeCapN);

    if (shouldReply) await this.reply(m.conversationId);
    this.persist();
  }

  private isMentioned(m: IncomingMessage): boolean {
    const handle = this.config.handle.toLowerCase();
    if (m.text.toLowerCase().includes(handle)) return true;
    return m.mentions.some((x) => x === this.client.userId || x.toLowerCase() === handle);
  }

  /** Generates and sends a reply from ONLY this conversation's window; resets the cadence counter on success. */
  private async reply(conversationId: string): Promise<void> {
    const window = this.store.loadContext(conversationId); // isolation: strictly this conversation's history
    const messages = window.map((c) => ({ role: c.role, content: c.content }));

    // Optional local-knowledge augmentation (default OFF, additive): only the
    // `system` string is ever touched here — `messages` (the conversation
    // window) remains untouched, preserving the isolation invariant above.
    let system = this.config.systemPrompt;
    if (this.knowledge) {
      const lastUser = [...window].reverse().find((m) => m.role === "user");
      if (lastUser) {
        try {
          const snippets = await this.knowledge.retrieve(lastUser.content, this.config.knowledgeTopK);
          if (snippets.length > 0) system += KNOWLEDGE_BLOCK(snippets);
        } catch (err) {
          // Never fail the reply because knowledge retrieval broke — degrade to the base prompt.
          this.logError(`knowledge.retrieve failed for ${conversationId}`, err);
        }
      }
    }

    let text: string;
    try {
      text = await this.llm.complete({ system, messages });
    } catch (err) {
      await this.degrade(conversationId, err);
      return;
    }
    await this.client.send(conversationId, text);
    this.logPlaintext(`send ${conversationId}: ${text}`);
    this.store.appendContext(conversationId, { role: "assistant", content: text, sentAt: Date.now() }, this.ctxOpts());
    const meta = this.store.loadConvMeta(conversationId);
    meta.humanSinceLastReply = 0;
    this.store.saveConvMeta(conversationId, meta);
  }

  /** LLM failure path: one polite in-thread message, rate-limited per conversation, never crash (5B.6). */
  private async degrade(conversationId: string, err: unknown): Promise<void> {
    this.logError(`LLM complete failed for ${conversationId}`, err);
    const now = Date.now();
    const last = this.lastDegradeAt.get(conversationId) ?? 0;
    if (now - last < DEGRADE_COOLDOWN_MS) return;
    this.lastDegradeAt.set(conversationId, now);
    try {
      await this.client.send(conversationId, DEGRADE_TEXT);
    } catch (sendErr) {
      this.logError(`degrade send failed for ${conversationId}`, sendErr);
    }
  }

  private async onSystemEvent(e: SystemEvent): Promise<void> {
    switch (e.type) {
      case "memberJoined":
      case "memberRemoved":
        // Another member changed — re-check our own membership + greet if new.
        // (The SDK never emits memberRemoved for THIS client; self-removal is
        // detected via the relay's 403 in reconcileConversation.)
        await this.reconcileConversation(e.conversationId);
        break;
      case "aiModeChanged":
      case "memberLeft":
      case "identityKeyChanged":
        break;
    }
  }

  /** Self-removal (5B.5): purge the conversation's context window + mode meta and drop its local cache entry, then persist. */
  private async handleSelfRemoval(conversationId: string): Promise<void> {
    this.store.purgeContext(conversationId);
    this.client.stores.conversations.delete(conversationId);
    this.persist();
    this.log(`self-removed from conversation ${conversationId}: purged context window + dropped local conversation cache`);
    await Promise.resolve();
  }

  /** Snapshots the full account state and writes it durably (after every mutation). */
  private persist(): void {
    this.store.save(this.currentState());
  }

  private currentState(): PersistedClientState {
    const id = this.client.serializedIdentity;
    return {
      token: this.client.token,
      userId: this.client.userId,
      username: this.client.username,
      deviceId: this.client.deviceId,
      nextOneTimePreKeyId: this.client.nextPreKeyId,
      serializedIdentity: {
        identityKeyPair: Buffer.from(id.identityKeyPair).toString("base64"),
        registrationId: id.registrationId,
      },
      serializedStores: this.serializeStores(),
    };
  }

  /** Serializes the SDK stores, narrowing to the concrete in-memory impl (no cast; fails fast otherwise). */
  private serializeStores(): SerializedClientStores {
    const stores = this.client.stores;
    if (!(stores instanceof InMemoryClientStores)) {
      throw new Error("SignalAgent: expected InMemoryClientStores to persist client state");
    }
    return stores.toJSON();
  }

  private log(msg: string): void {
    console.log(`[agent] ${msg}`);
  }

  private logError(msg: string, err: unknown): void {
    console.error(`[agent] ${msg}: ${err instanceof Error ? err.message : String(err)}`);
  }

  /** Plaintext bodies only ever leave via here, and only at debug level when DEBUG_PLAINTEXT is set. */
  private logPlaintext(msg: string): void {
    if (this.config.debugPlaintext) console.debug(`[agent:plaintext] ${msg}`);
  }
}
