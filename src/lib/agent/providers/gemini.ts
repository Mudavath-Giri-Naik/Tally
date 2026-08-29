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
  TransientProviderError,
  withRetry,
  type AgentDecision,
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

export class GeminiProvider implements DecisionProvider {
  readonly name = "gemini";
  readonly model: string;

  constructor(model?: string) {
    this.model = model ?? optionalEnv("GEMINI_MODEL") ?? DEFAULT_MODEL;
  }

  async decide(system: string, user: string): Promise<AgentDecision> {
    const apiKey = requireEnv(
      "GEMINI_API_KEY",
      "the recovery decision engine (TALLY_LLM_PROVIDER=gemini)",
    );
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
        throw new TransientProviderError(message);
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
      // MAX_TOKENS here means the JSON is truncated and unparseable.
      throw new Error(
        `Gemini stopped early (${candidate.finishReason}) - decision incomplete`,
      );
    }

    const text = candidate.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    if (!text.trim()) throw new TransientProviderError("Gemini returned empty content");
    return text;
  }
}
