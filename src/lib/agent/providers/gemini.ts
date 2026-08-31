/**
 * Gemini decision provider.
 *
 * Talks to the Generative Language REST API directly. The response is
 * constrained server-side with `responseSchema`, then validated again against
 * the Zod schema before Tally trusts it - a model that returns valid JSON of
 * the wrong shape must not reach the guardrails.
 *
 * Model note: the Pro tiers are quota-limited on free keys and the "latest"
 * aliases return 503 under load, so the default is a specific Flash model that
 * is consistently available. Override with GEMINI_MODEL.
 */
import { requireEnv, optionalEnv } from "../../env";
import {
  DecisionSchema,
  ReplySchema,
  SummarySchema,
  CommandSchema,
  TransientProviderError,
  withRetry,
  type AgentDecision,
  type AgentReply,
  type AgentSummary,
  type AgentCommand,
  type DecisionProvider,
} from "./index";

const DEFAULT_MODEL = "gemini-3.5-flash";
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * Gemini's schema dialect (uppercase types, `nullable`) rather than JSON
 * Schema. Written out rather than generated from the Zod schema so the two
 * stay independently readable; the Zod schema remains the validator.
 */
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    intervention: {
      type: "STRING",
      enum: [
        "send_message",
        "schedule_retry",
        "request_new_method",
        "escalate_human",
        "stop",
      ],
      description: "The single next action to take on this event.",
    },
    channel: {
      type: "STRING",
      enum: ["email", "whatsapp", "voice"],
      nullable: true,
      description: "Which channel to use. Null when no message is being sent.",
    },
    subject: {
      type: "STRING",
      nullable: true,
      description: "Email subject line. Null for whatsapp and voice.",
    },
    message: {
      type: "STRING",
      description: "The exact message to send, ready to go out verbatim.",
    },
    rationale: {
      type: "STRING",
      description: "One or two sentences on why this action, for the audit trail.",
    },
  },
  required: ["intervention", "channel", "subject", "message", "rationale"],
} as const;

/** The conversational counterpart, in Gemini's schema dialect. */
const REPLY_SCHEMA = {
  type: "OBJECT",
  properties: {
    message: {
      type: "STRING",
      description:
        "The reply to send to the customer, ready to go out verbatim on WhatsApp.",
    },
    needs_human: {
      type: "BOOLEAN",
      description:
        "True when a person at the merchant should read this thread afterwards.",
    },
    topic: {
      type: "STRING",
      description: "Two or three words naming what the customer asked about.",
    },
  },
  required: ["message", "needs_human", "topic"],
} as const;

const COMMAND_SCHEMA = {
  type: "OBJECT",
  properties: {
    reply: {
      type: "STRING",
      description:
        "What to say back to the admin. Always populated, even when no action is taken.",
    },
    action: {
      type: "STRING",
      enum: [
        "none",
        "send_whatsapp",
        "send_email",
        "place_call",
        "get_payment_link",
        "set_contact_window",
        "mark_paid",
        "pause_outreach",
        "resume_outreach",
        "snooze",
        "trigger_next_step",
        "escalate_human",
        "opt_out",
        "reopen_case",
        "write_off",
        "flag_disputed",
      ],
      description: "The single action to carry out, or 'none' to just answer.",
    },
    message: {
      type: "STRING",
      nullable: true,
      description: "The body to send, when the action is a send or a call.",
    },
    window_start: { type: "STRING", nullable: true, description: "HH:MM, 24-hour." },
    window_end: { type: "STRING", nullable: true, description: "HH:MM, 24-hour." },
    snooze_until: { type: "STRING", nullable: true, description: "YYYY-MM-DD." },
    reason: {
      type: "STRING",
      nullable: true,
      description: "Short note recorded in the audit trail.",
    },
  },
  required: ["reply", "action"],
} as const;

const SUMMARY_SCHEMA = {
  type: "OBJECT",
  properties: {
    summary: {
      type: "STRING",
      description:
        "Two or three sentences: what the customer asked, what was said, where it left off.",
    },
    needs_human: {
      type: "BOOLEAN",
      description: "True when the thread still needs a person to pick it up.",
    },
  },
  required: ["summary", "needs_human"],
} as const;

/**
 * The wait Gemini asks for on a 429, in ms.
 *
 * It returns a RetryInfo detail like `"retryDelay": "27s"`. Free-tier limits
 * are per minute, so the honest wait is tens of seconds - far longer than an
 * exponential backoff would guess, which is why a throttle that would have
 * cleared itself was being reported as a failure.
 */
export function retryDelayMs(body: string): number | undefined {
  const m = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (!m) return undefined;
  const seconds = Number(m[1]);
  return Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : undefined;
}

export class GeminiProvider implements DecisionProvider {
  readonly name = "gemini";
  readonly model: string;

  /** Supplied from the key pool; falls back to the environment. */
  private readonly apiKey?: string;

  constructor(model?: string, apiKey?: string) {
    this.model = model ?? optionalEnv("GEMINI_MODEL") ?? DEFAULT_MODEL;
    this.apiKey = apiKey;
  }

  /** The pooled key if there is one, otherwise the environment's. */
  private key(): string {
    return (
      this.apiKey ??
      requireEnv("GEMINI_API_KEY", "the recovery decision engine (provider: gemini)")
    );
  }

  async decide(system: string, user: string): Promise<AgentDecision> {
    const apiKey = this.key();
    const base = optionalEnv("GEMINI_BASE_URL") ?? ENDPOINT;

    const body = {
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
        temperature: 0.4,
        maxOutputTokens: 2048,
      },
      // Recovery copy discusses failed payments and money. The default filters
      // occasionally treat debt-collection phrasing as harassment; these keep
      // legitimate dunning messages from being blocked, without disabling the
      // categories that matter.
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
      ],
    };

    const raw = await withRetry(
      () => this.call(base, apiKey, body),
      { label: `gemini:${this.model}` },
    );

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `Gemini returned text that was not JSON: ${raw.slice(0, 200)}`,
      );
    }

    const result = DecisionSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `Gemini decision failed validation: ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    return result.data;
  }

  async reply(system: string, user: string): Promise<AgentReply> {
    // Warmer than a decision: this is read by a person mid-conversation, and
    // a reply that sounds like a form letter reads as a bot stalling them.
    //
    // The token budget is not about the length of the reply - a WhatsApp
    // message is fifty words. Flash reasons before it emits, and that
    // reasoning is charged to the same budget, so a tight cap does not
    // truncate the message, it stops the JSON ever being closed and the whole
    // call fails with MAX_TOKENS. It grows with the transcript, which is how
    // a conversation that worked at three turns stops working at fifteen.
    const parsed = await this.generate(system, user, REPLY_SCHEMA, 0.7, 4096);
    const result = ReplySchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `Gemini reply failed validation: ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    return result.data;
  }

  async command(system: string, user: string): Promise<AgentCommand> {
    const parsed = await this.generate(system, user, COMMAND_SCHEMA, 0.2, 4096);
    const result = CommandSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `Gemini command failed validation: ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    return result.data;
  }

  async summarise(system: string, user: string): Promise<AgentSummary> {
    const parsed = await this.generate(system, user, SUMMARY_SCHEMA, 0.2, 4096);
    const result = SummarySchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `Gemini summary failed validation: ${result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    return result.data;
  }

  /** Shared request shape for every structured call this provider makes. */
  private async generate(
    system: string,
    user: string,
    responseSchema: unknown,
    temperature: number,
    maxOutputTokens: number,
  ): Promise<unknown> {
    const apiKey = this.key();
    const base = optionalEnv("GEMINI_BASE_URL") ?? ENDPOINT;

    const raw = await withRetry(
      () =>
        this.call(base, apiKey, {
          system_instruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema,
            temperature,
            maxOutputTokens,
          },
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
            {
              category: "HARM_CATEGORY_DANGEROUS_CONTENT",
              threshold: "BLOCK_ONLY_HIGH",
            },
          ],
        }),
      { label: `gemini:${this.model}` },
    );

    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(
        `Gemini returned text that was not JSON: ${raw.slice(0, 200)}`,
      );
    }
  }

  /** One HTTP round trip. Returns the raw JSON text the model produced. */
  private async call(
    base: string,
    apiKey: string,
    body: unknown,
  ): Promise<string> {
    let res: Response;
    try {
      res = await fetch(`${base}/${this.model}:generateContent`, {
        method: "POST",
        headers: {
          "x-goog-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      // Network failure or timeout - always worth another try.
      throw new TransientProviderError(
        `Gemini request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!res.ok) {
      const text = await res.text();
      const message = `Gemini ${res.status}: ${text.slice(0, 250)}`;
      // 429 quota, 503 high demand, 5xx - transient. 400/401/403 are not.
      if (res.status === 429 || res.status >= 500) {
        throw new TransientProviderError(message, retryDelayMs(text));
      }
      throw new Error(message);
    }

    const json = (await res.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        finishReason?: string;
      }>;
      promptFeedback?: { blockReason?: string };
    };

    if (json.promptFeedback?.blockReason) {
      throw new Error(
        `Gemini blocked the prompt: ${json.promptFeedback.blockReason}`,
      );
    }

    const candidate = json.candidates?.[0];
    if (!candidate) throw new TransientProviderError("Gemini returned no candidates");

    if (candidate.finishReason && candidate.finishReason !== "STOP") {
      // MAX_TOKENS here means the JSON is truncated and unparseable. Worth one
      // more attempt: the reasoning length varies between runs, so the same
      // request can fit on a retry - and the alternative is no answer at all.
      const message = `Gemini stopped early (${candidate.finishReason}) - output incomplete`;
      if (candidate.finishReason === "MAX_TOKENS") {
        throw new TransientProviderError(message);
      }
      throw new Error(message);
    }

    const text = candidate.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    if (!text.trim()) throw new TransientProviderError("Gemini returned empty content");
    return text;
  }
}
