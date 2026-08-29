/**
 * The decision engine's model backend.
 *
 * Tally's decision logic does not care which model writes the recovery
 * message - it cares that something returns a valid, schema-checked decision.
 * That is the whole contract below, so a provider can be swapped without
 * touching the guardrails, the worker, or the audit trail.
 *
 * Selection order:
 *   1. TALLY_LLM_PROVIDER, if set explicitly ("anthropic" | "gemini")
 *   2. whichever API key is present (Anthropic preferred when both are)
 *   3. none - decide() then uses its templated fallback
 */
import { z } from "zod";
import { optionalEnv, isConfigured } from "../../env";

/** The decision every provider must return. Validated before it is trusted. */
export const DecisionSchema = z.object({
  intervention: z.enum([
    "send_message",
    "schedule_retry",
    "request_new_method",
    "escalate_human",
    "stop",
  ]),
  channel: z.enum(["email", "whatsapp", "voice"]).nullable(),
  subject: z.string().nullable(),
  message: z.string().min(1),
  rationale: z.string().min(1),
});

export type AgentDecision = z.infer<typeof DecisionSchema>;

export interface DecisionProvider {
  /** Recorded in the audit trail so you can tell which brain made a call. */
  readonly name: string;
  readonly model: string;
  decide(system: string, user: string): Promise<AgentDecision>;
}

export type ProviderName = "anthropic" | "gemini";

export function selectedProviderName(): ProviderName | null {
  const explicit = optionalEnv("TALLY_LLM_PROVIDER")?.toLowerCase();
  if (explicit === "anthropic" || explicit === "gemini") {
    return explicit;
  }
  if (explicit) {
    throw new Error(
      `TALLY_LLM_PROVIDER must be "anthropic" or "gemini", got "${explicit}".`,
    );
  }
  if (isConfigured("ANTHROPIC_API_KEY")) return "anthropic";
  if (isConfigured("GEMINI_API_KEY")) return "gemini";
  return null;
}

/** Build the configured provider, or null when no model is configured. */
export async function getProvider(): Promise<DecisionProvider | null> {
  const name = selectedProviderName();
  if (name === "anthropic") {
    const { AnthropicProvider } = await import("./anthropic");
    return new AnthropicProvider();
  }
  if (name === "gemini") {
    const { GeminiProvider } = await import("./gemini");
    return new GeminiProvider();
  }
  return null;
}

/**
 * Retry transient upstream failures.
 *
 * Both providers rate-limit, and Gemini's free tier returns 503 "high demand"
 * often enough that a single attempt would drop real decisions onto the
 * template path. Permanent errors (bad key, bad request) are not retried -
 * they will fail identically the second time.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseDelayMs?: number; label: string } = {
    label: "model",
  },
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 700;
  let lastErr: unknown;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable = (err as { retryable?: boolean }).retryable === true;
      if (!retryable || i === attempts - 1) throw err;
      const delay = base * Math.pow(2, i);
      console.warn(
        `[agent] ${opts.label} attempt ${i + 1}/${attempts} failed, retrying in ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/** An upstream failure that is worth trying again. */
export class TransientProviderError extends Error {
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = "TransientProviderError";
  }
}
