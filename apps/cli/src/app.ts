import type { SignalAiClient, Member } from "@signalai/client-sdk";
import type { CliConfig } from "./config.js";
import type { CliSession } from "./session.js";
import type { CliTrustStore } from "./trust-store.js";
import {
  formatDate,
  formatFingerprint,
  formatTime,
  line,
  shortUserId,
  type OutputSink,
  type RenderedLine,
  type RenderKind,
} from "./render.js";

/** The honest reassurance printed on AI removal (Liotta): removal is real, not cosmetic. */
export const AI_REMOVED_LINE = "AI removed — new messages are not encrypted to it.";

/** One member row as the TUI sidebar needs it — a read-only projection, no business logic. */
export interface SidebarMember {
  userId: string;
  /** Resolved display name (username if known, else short userId). */
  name: string;
  /** Space-grouped identity-key fingerprint (`formatFingerprint`), or the no-key placeholder. */
  fingerprint: string;
  role: "admin" | "member";
  /** True when this member is the conversation's AI account. */
  isAi: boolean;
  /** For the AI member only: whether it is in active (●) vs passive (○) mode. */
  aiActive: boolean;
  /** True when the member is verified AND their current fingerprint still matches. */
  verified: boolean;
  /** True for the local account (never rendered as verifiable). */
  isSelf: boolean;
}

/** The header + member sidebar the TUI paints for the active conversation. */
export interface ConversationView {
  conversationId: string;
  label: string;
  members: SidebarMember[];
}

/**
 * The load-bearing honesty note (Liotta, non-negotiable): passive mode does NOT
 * hide the thread from the AI — it is a full member that receives and decrypts
 * every message; passive controls only whether it *responds* unprompted.
 */
const PASSIVE_HONESTY_NOTE =
  "The AI is a full member and decrypts every message; passive means it only replies when you @mention it.";

/** Case-insensitive `@ai` mention detector (word-bounded so `@aid` is not a mention). */
const AI_MENTION = /(^|\s)@ai(\b|$)/i;

export interface CliAppDeps {
  client: SignalAiClient;
  trust: CliTrustStore;
  config: CliConfig;
  /** Persists SDK account state after every mutation; defaults to a no-op (pure-logic tests). */
  persist?: () => void;
  /** Where async events are pushed in addition to the internal buffer. */
  sink?: OutputSink;
  /** Injectable clock for deterministic timestamps. */
  now?: () => number;
}

/**
 * The headless CLI core: owns a {@link SignalAiClient} + a {@link CliTrustStore}
 * and turns a line of input into {@link RenderedLine}s. `handleInput` returns
 * the SYNCHRONOUS result of a command / an outgoing message (optimistic echo);
 * ASYNC events (incoming messages, membership/mode changes, connection state,
 * key-change warnings) are pushed to the {@link OutputSink} and mirrored to an
 * internal buffer so a test can drive `handleInput` and assert on both streams
 * without a PTY. All I/O lives in the thin `main.ts` adapter, never here.
 */
export class CliApp {
  private readonly client: SignalAiClient;
  private readonly trust: CliTrustStore;
  private readonly config: CliConfig;
  private readonly persist: () => void;
  private readonly now: () => number;

  private sink: OutputSink | undefined;
  private readonly buffer: RenderedLine[] = [];
  private readonly labels = new Map<string, string>();
  private readonly joinedSeen = new Set<string>();
  private activeId: string | undefined;

  constructor(deps: CliAppDeps) {
    this.client = deps.client;
    this.trust = deps.trust;
    this.config = deps.config;
    this.persist = deps.persist ?? ((): void => undefined);
    this.now = deps.now ?? ((): number => Date.now());
    this.sink = deps.sink;
    this.wireHandlers();
  }

  /** Builds a {@link CliApp} bound to a live {@link CliSession}'s client, trust store, and persistence. */
  static fromSession(session: CliSession, config: CliConfig, opts: { sink?: OutputSink; now?: () => number } = {}): CliApp {
    return new CliApp({
      client: session.client,
      trust: session.trustStore,
      config,
      persist: session.persist,
      sink: opts.sink,
      now: opts.now,
    });
  }

  /** Installs (or replaces) the async output sink (the readline adapter sets this to `print`). */
  setSink(sink: OutputSink): void {
    this.sink = sink;
  }

  /** Every async line produced so far (incoming messages, system events, warnings, connection changes). */
  get emittedLines(): readonly RenderedLine[] {
    return this.buffer;
  }

  /** The active conversation id, or `undefined` before `/new` (or a joined conversation). */
  get activeConversationId(): string | undefined {
    return this.activeId;
  }

  /**
   * A read-only projection of the active conversation for the TUI header +
   * member sidebar. Additive and side-effect-free: it reuses the SAME sources
   * `/members` renders from (`client.listMembers`, `client.getAiMode`, the trust
   * store) so the sidebar never diverges from the command surface. Returns
   * `undefined` when nothing is active yet. Async because `listMembers` may
   * refresh from the relay, exactly like `cmdMembers`.
   */
  async conversationView(): Promise<ConversationView | undefined> {
    const conv = this.activeId;
    if (conv === undefined) return undefined;
    const aiUserId = this.trust.getAiMember(conv);
    const aiActive = this.client.getAiMode(conv);
    const members = await this.client.listMembers(conv);
    return {
      conversationId: conv,
      label: this.labels.get(conv) ?? shortUserId(conv),
      members: members.map((m): SidebarMember => {
        const isAi = m.userId === aiUserId;
        const isSelf = m.userId === this.client.userId;
        return {
          userId: m.userId,
          name: this.displayName(m.userId),
          fingerprint: formatFingerprint(m.identityKeyFingerprint),
          role: m.role,
          isAi,
          aiActive: isAi ? aiActive : false,
          verified: !isSelf && this.trust.isVerified(conv, m.userId, m.identityKeyFingerprint),
          isSelf,
        };
      }),
    };
  }

  // --- input dispatch ------------------------------------------------------

  /**
   * Handles one line: a slash command, or (otherwise) an outgoing chat message
   * with `@ai`-mention wiring and optimistic local echo. Returns the lines to
   * print for THIS input; async consequences arrive later via the sink.
   */
  async handleInput(input: string): Promise<RenderedLine[]> {
    const trimmed = input.trim();
    if (trimmed.length === 0) return [];
    if (trimmed.startsWith("/")) return this.dispatchCommand(trimmed);
    return this.sendChat(trimmed);
  }

  private async dispatchCommand(input: string): Promise<RenderedLine[]> {
    const [cmd, ...rest] = input.slice(1).split(/\s+/);
    const arg = rest.join(" ").trim();
    try {
      switch (cmd) {
        case "new":
          return await this.cmdNew(arg);
        case "invite":
          return await this.cmdInvite(arg);
        case "remove":
          return await this.cmdRemove(arg);
        case "members":
          return await this.cmdMembers();
        case "verify":
          return await this.cmdVerify(arg);
        case "ai":
          return await this.cmdAi(rest);
        case "help":
          return this.cmdHelp();
        case "quit":
          return this.cmdQuit();
        default:
          return [this.err(`unknown command "/${cmd ?? ""}" — try /help`)];
      }
    } catch (err) {
      return [this.err(`/${cmd ?? ""} failed: ${err instanceof Error ? err.message : String(err)}`)];
    }
  }

  private async sendChat(text: string): Promise<RenderedLine[]> {
    const conv = this.activeId;
    if (!conv) return [this.err("no active conversation — use /new <name> first")];
    const aiUserId = this.trust.getAiMember(conv);
    // `@ai` addresses the AI member only when one is known for this conversation;
    // otherwise it is literal text (the SDK receives no mention).
    const mentions = aiUserId && AI_MENTION.test(text) ? [aiUserId] : [];
    try {
      await this.client.send(conv, text, mentions);
    } catch (err) {
      return [this.err(`send failed: ${err instanceof Error ? err.message : String(err)}`)];
    }
    this.persist();
    return [this.msgLine(this.client.username, text, this.now())];
  }

  // --- commands ------------------------------------------------------------

  private async cmdNew(name: string): Promise<RenderedLine[]> {
    const label = name.length > 0 ? name : "(unnamed)";
    const conv = await this.client.createConversation([]);
    this.activeId = conv;
    this.labels.set(conv, label);
    this.persist();
    return [this.info(`Created conversation "${label}" (${shortUserId(conv)}). It is now active.`)];
  }

  private async cmdInvite(username: string): Promise<RenderedLine[]> {
    const conv = this.activeId;
    if (!conv) return [this.err("no active conversation — use /new <name> first")];
    if (username.length === 0) return [this.err("usage: /invite <username>")];
    const { userId } = await this.client.resolveUser(username);
    this.trust.setDirectory(userId, username);
    await this.client.invite(conv, userId);
    this.persist();
    return [this.info(`Invited ${username}.`)];
  }

  private async cmdRemove(username: string): Promise<RenderedLine[]> {
    const conv = this.activeId;
    if (!conv) return [this.err("no active conversation — use /new <name> first")];
    if (username.length === 0) return [this.err("usage: /remove <username>")];
    const { userId } = await this.client.resolveUser(username);
    await this.client.removeMember(conv, userId);
    this.persist();
    return [this.info(`Removed ${username}.`)];
  }

  private async cmdMembers(): Promise<RenderedLine[]> {
    const conv = this.activeId;
    if (!conv) return [this.err("no active conversation — use /new <name> first")];
    const members = await this.client.listMembers(conv);
    const aiUserId = this.trust.getAiMember(conv);
    const label = this.labels.get(conv) ?? shortUserId(conv);
    const out: RenderedLine[] = [this.info(`Members of "${label}":`)];
    let hasAi = false;
    for (const m of members) {
      out.push(this.info(`  ${this.renderMember(conv, m, aiUserId)}`));
      if (m.userId === aiUserId) hasAi = true;
    }
    if (hasAi) out.push(this.info(`Note: ${PASSIVE_HONESTY_NOTE}`));
    return out;
  }

  /** One `/members` row: name [AI · mode] — fingerprint — joined date — role [✓]. */
  private renderMember(conv: string, m: Member, aiUserId: string | undefined): string {
    const name = this.displayName(m.userId);
    const isAi = m.userId === aiUserId;
    const aiLabel = isAi ? ` [AI · ${this.client.getAiMode(conv) ? "active" : "passive"}]` : "";
    const fp = formatFingerprint(m.identityKeyFingerprint);
    const joined = formatDate(m.joinedAt);
    const verified =
      m.userId !== this.client.userId && this.trust.isVerified(conv, m.userId, m.identityKeyFingerprint);
    const check = verified ? " ✓" : "";
    return `${name}${aiLabel} — ${fp} — joined ${joined} — ${m.role}${check}`;
  }

  private async cmdVerify(username: string): Promise<RenderedLine[]> {
    const conv = this.activeId;
    if (!conv) return [this.err("no active conversation — use /new <name> first")];
    if (username.length === 0) return [this.err("usage: /verify <username>")];
    const { userId } = await this.client.resolveUser(username);
    this.trust.setDirectory(userId, username);
    const members = await this.client.listMembers(conv);
    const member = members.find((m) => m.userId === userId);
    if (!member) return [this.err(`${username} is not a member of this conversation`)];
    if (member.identityKeyFingerprint.length === 0) {
      return [this.err(`no identity key on file for ${username} yet — exchange a message first`)];
    }
    this.trust.setVerified(conv, userId, member.identityKeyFingerprint);
    this.persist();
    return [
      this.info(`Compare this fingerprint with ${username} out-of-band (read it aloud, side by side):`),
      this.info(`  ${formatFingerprint(member.identityKeyFingerprint)}`),
      this.info(`${username} marked verified. /members shows ✓ until their key changes.`),
    ];
  }

  private async cmdAi(rest: string[]): Promise<RenderedLine[]> {
    const [sub, ...subRest] = rest;
    switch (sub) {
      case "passive":
      case "active":
        return this.cmdAiMode(sub === "active");
      case "invite":
        return this.cmdAiInvite(subRest.join(" ").trim());
      case "remove":
        return this.cmdAiRemove();
      default:
        return [this.err("usage: /ai <passive|active|invite [username]|remove>")];
    }
  }

  private async cmdAiMode(active: boolean): Promise<RenderedLine[]> {
    const conv = this.activeId;
    if (!conv) return [this.err("no active conversation — use /new <name> first")];
    await this.client.setAiMode(conv, active);
    this.persist();
    const note = active
      ? "AI mode set to active — it may reply unprompted (and whenever you @mention it)."
      : "AI mode set to passive — it still decrypts every message; it only replies when you @mention it.";
    return [this.info(note)];
  }

  private async cmdAiInvite(inlineUsername: string): Promise<RenderedLine[]> {
    const conv = this.activeId;
    if (!conv) return [this.err("no active conversation — use /new <name> first")];
    const aiUsername = inlineUsername.length > 0 ? inlineUsername : this.config.aiUsername;
    if (!aiUsername) {
      return [this.err("no AI username configured — set SIGNALAI_AI_USERNAME or run /ai invite <username>")];
    }
    const { userId } = await this.client.resolveUser(aiUsername);
    this.trust.setDirectory(userId, aiUsername);
    await this.client.invite(conv, userId);
    this.trust.setAiMember(conv, userId);
    this.persist();
    return [
      this.info(
        `Invited AI member "${aiUsername}". It is a full member and decrypts every message; "passive" means it only replies when @mentioned.`,
      ),
    ];
  }

  private async cmdAiRemove(): Promise<RenderedLine[]> {
    const conv = this.activeId;
    if (!conv) return [this.err("no active conversation — use /new <name> first")];
    const aiUserId = this.trust.getAiMember(conv);
    if (!aiUserId) return [this.err("no AI member in this conversation")];
    await this.client.removeMember(conv, aiUserId);
    this.trust.deleteAiMember(conv);
    this.persist();
    return [this.info(AI_REMOVED_LINE)];
  }

  private cmdHelp(): RenderedLine[] {
    const lines = [
      "Commands:",
      "  /new <name>            create a conversation and make it active",
      "  /invite <username>     add a member (resolves them by username)",
      "  /remove <username>     remove a member",
      "  /members               list members with fingerprints, roles, ✓ verified",
      "  /verify <username>     compare a member's fingerprint out-of-band, mark verified",
      "  /ai invite [username]  invite the AI member (SIGNALAI_AI_USERNAME by default)",
      "  /ai passive|active     set whether the AI replies unprompted",
      "  /ai remove             remove the AI member",
      "  @ai <text>             mention the AI so it replies (passive or active)",
      "  /help                  show this help",
      "  /quit                  disconnect and exit",
      `Note: ${PASSIVE_HONESTY_NOTE}`,
    ];
    return lines.map((t) => this.info(t));
  }

  private cmdQuit(): RenderedLine[] {
    this.client.disconnect();
    return [this.info("Disconnected. Bye.")];
  }

  // --- async event handlers (pushed to the sink) ---------------------------

  private wireHandlers(): void {
    this.client.onMessage = (m): void => {
      if (m.senderUserId === this.client.userId) return; // never echo our own (the SDK already excludes self)
      // An invited member never runs `/new`, so they have no active conversation
      // and `sendChat` would reject their replies. The first message they receive
      // is their cue to join: adopt it as active so the invitee can reply,
      // `/members`, `/verify`, and manage the AI. Only when nothing is active yet
      // (a `/new` conversation is never overridden).
      if (this.activeId === undefined) {
        this.activeId = m.conversationId;
        if (!this.labels.has(m.conversationId)) this.labels.set(m.conversationId, shortUserId(m.conversationId));
        this.emit([
          this.info(
            `You joined a conversation (${shortUserId(m.conversationId)}). Type to reply; /members to see who's here.`,
          ),
        ]);
      }
      this.emit([this.msgLine(this.displayName(m.senderUserId), m.text, m.sentAt)]);
      this.persist();
    };
    this.client.onSystemEvent = (e): void => {
      switch (e.type) {
        case "memberJoined": {
          const key = `${e.conversationId}:${e.userId}`;
          if (this.joinedSeen.has(key)) break; // one line per member, not per device
          this.joinedSeen.add(key);
          this.emit([this.system(`${this.displayName(e.userId)} joined the conversation`)]);
          break;
        }
        case "memberRemoved":
          this.joinedSeen.delete(`${e.conversationId}:${e.userId}`);
          this.emit([this.system(`${this.displayName(e.userId)} was removed from the conversation`)]);
          break;
        case "aiModeChanged":
          this.emit([this.system(`AI mode changed to ${e.enabled ? "active" : "passive"}`)]);
          break;
        case "identityKeyChanged": {
          // Reverse-map the userId to a name, warn prominently, and RESET trust:
          // the recorded fingerprint no longer matches, so ✓ must disappear.
          const name = this.displayName(e.userId);
          this.trust.deleteVerifiedForUser(e.userId);
          this.emit([this.warn(`⚠ ${name}'s security fingerprint changed — verify again`)]);
          break;
        }
        case "memberLeft":
          break; // never emitted by the SDK
      }
      this.persist();
    };
    this.client.onConnectionChange = (state): void => {
      this.emit([this.connection(`[connection: ${state}]`)]);
    };
  }

  // --- rendering helpers ---------------------------------------------------

  private emit(lines: RenderedLine[]): void {
    if (lines.length === 0) return;
    this.buffer.push(...lines);
    this.sink?.(lines);
  }

  private displayName(userId: string): string {
    if (userId === this.client.userId) return this.client.username;
    return this.trust.getUsername(userId) ?? shortUserId(userId);
  }

  private msgLine(name: string, text: string, ts: number): RenderedLine {
    return line("message", `${formatTime(ts)} ${name}: ${text}`, ts);
  }

  private mk(kind: RenderKind, text: string): RenderedLine {
    return line(kind, text, this.now());
  }
  private info(text: string): RenderedLine {
    return this.mk("info", text);
  }
  private err(text: string): RenderedLine {
    return this.mk("error", text);
  }
  private system(text: string): RenderedLine {
    return line("system", `${formatTime(this.now())} · ${text}`, this.now());
  }
  private warn(text: string): RenderedLine {
    return this.mk("warn", text);
  }
  private connection(text: string): RenderedLine {
    return this.mk("connection", text);
  }
}
