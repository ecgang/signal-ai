/**
 * Provider-agnostic LLM layer for the AI member. The agent depends only on the
 * {@link LlmClient} interface; concrete providers (OpenAI-compatible, Anthropic)
 * and the deterministic {@link MockLlmClient} used by every test are selected at
 * boot via {@link selectLlmClient}. No provider secret is hardcoded — base URLs
 * and models are env-overridable constants; keys come from env only.
 */

/** One completion request: a system prompt plus an ordered user/assistant transcript. */
export interface LlmCompletionRequest {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  model?: string;
}

/** The seam the agent talks to. Implementations must never throw for a merely-empty transcript. */
export interface LlmClient {
  /** Stable provider identifier (`openai-compatible` | `anthropic` | `mock`). */
  readonly provider: string;
  complete(req: LlmCompletionRequest): Promise<string>;
}

// Env-overridable defaults. The default provider targets an OpenAI-compatible
// endpoint (NVIDIA NIM) with a Nemotron model; both are just strings, not secrets.
export const DEFAULT_OPENAI_BASE_URL = "https://integrate.api.nvidia.com/v1";
export const DEFAULT_OPENAI_MODEL = "nvidia/llama-3.1-nemotron-70b-instruct";
export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";
export const ANTHROPIC_VERSION = "2023-06-01";

/** Provider-neutral system prompt stating the membership/consent context (5B.4). */
export const DEFAULT_SYSTEM_PROMPT =
  "You are the AI member of this end-to-end-encrypted group chat. You were invited to it explicitly and only ever see messages from threads you are a member of. Be concise and conversational, matching a group-chat register. Do not claim to see anything outside this conversation.";

/** Default OpenAI-compatible provider: POSTs `/chat/completions` with a Bearer key. */
export class OpenAiCompatibleLlmClient implements LlmClient {
  readonly provider = "openai-compatible";

  constructor(private readonly opts: { baseUrl: string; apiKey: string; model: string }) {}

  async complete(req: LlmCompletionRequest): Promise<string> {
    const res = await fetch(`${this.opts.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({
        model: req.model ?? this.opts.model,
        messages: [{ role: "system", content: req.system }, ...req.messages],
      }),
    });
    if (!res.ok) {
      throw new Error(`OpenAiCompatibleLlmClient: request failed ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("OpenAiCompatibleLlmClient: response missing choices[0].message.content");
    }
    return content;
  }
}

/** Anthropic Messages API provider (`AGENT_PROVIDER=anthropic`). */
export class AnthropicLlmClient implements LlmClient {
  readonly provider = "anthropic";

  constructor(private readonly opts: { baseUrl: string; apiKey: string; model: string }) {}

  async complete(req: LlmCompletionRequest): Promise<string> {
    const res = await fetch(`${this.opts.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.opts.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: req.model ?? this.opts.model,
        max_tokens: 1024,
        system: req.system,
        messages: req.messages,
      }),
    });
    if (!res.ok) {
      throw new Error(`AnthropicLlmClient: request failed ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = json.content?.find((b) => b.type === "text")?.text;
    if (typeof text !== "string") {
      throw new Error("AnthropicLlmClient: response missing a text content block");
    }
    return text;
  }
}

/**
 * Deterministic in-process client for tests: records the exact
 * {@link LlmCompletionRequest} it was called with (deep-copied so later mutation
 * of the caller's window can't retroactively rewrite history — load-bearing for
 * the cross-conversation isolation assertion), and either returns a canned reply
 * or throws when {@link fail} is set (degradation test). No network, no keys.
 */
export class MockLlmClient implements LlmClient {
  readonly provider = "mock";
  readonly calls: LlmCompletionRequest[] = [];
  fail = false;
  private readonly reply: (req: LlmCompletionRequest) => string;

  constructor(reply?: (req: LlmCompletionRequest) => string) {
    this.reply = reply ?? ((req) => `mock-reply:${req.messages.at(-1)?.content ?? ""}`);
  }

  async complete(req: LlmCompletionRequest): Promise<string> {
    this.calls.push(JSON.parse(JSON.stringify(req)) as LlmCompletionRequest);
    if (this.fail) throw new Error("MockLlmClient: forced failure");
    return this.reply(req);
  }
}

/** The subset of env the factory reads. `process.env` satisfies this structurally. */
export interface LlmEnv {
  AGENT_PROVIDER?: string;
  AGENT_LLM_BASE_URL?: string;
  AGENT_LLM_API_KEY?: string;
  AGENT_MODEL?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
}

/** Returns the {@link LlmClient} implementation selected by `AGENT_PROVIDER` (default `openai-compatible`). */
export function selectLlmClient(env: LlmEnv = process.env): LlmClient {
  const provider = env.AGENT_PROVIDER ?? "openai-compatible";
  switch (provider) {
    case "mock":
      return new MockLlmClient();
    case "anthropic":
      return new AnthropicLlmClient({
        baseUrl: env.ANTHROPIC_BASE_URL ?? DEFAULT_ANTHROPIC_BASE_URL,
        apiKey: env.ANTHROPIC_API_KEY ?? "",
        model: env.AGENT_MODEL ?? DEFAULT_ANTHROPIC_MODEL,
      });
    case "openai-compatible":
      return new OpenAiCompatibleLlmClient({
        baseUrl: env.AGENT_LLM_BASE_URL ?? DEFAULT_OPENAI_BASE_URL,
        apiKey: env.AGENT_LLM_API_KEY ?? "",
        model: env.AGENT_MODEL ?? DEFAULT_OPENAI_MODEL,
      });
    default:
      throw new Error(`selectLlmClient: unknown AGENT_PROVIDER "${provider}" (expected openai-compatible | anthropic | mock)`);
  }
}
