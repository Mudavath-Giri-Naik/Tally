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

/**
 * A reply in a live conversation with a customer.
 *
 * Separate from DecisionSchema because the two jobs are different: a decision
 * chooses one action on an event, while this writes the next turn of a chat.
 * `needs_human` is the model's own hand-raise - it is not a refusal to answer,
 * it flags the thread for a person to read afterwards.
 */
export const ReplySchema = z.object({
  message: z.string().min(1),
  needs_human: z.boolean(),
  /** Two or three words for the activity feed, e.g. "asked about the link". */
  topic: z.string().min(1),
});

export type AgentReply = z.infer<typeof ReplySchema>;

/**
 * What the agent understood an admin to be asking for, in the panel's chat.
 *
 * Deliberately one action per turn rather than a tool-calling loop: an admin
 * saying "message them now" wants that done and confirmed, not a chain of
 * calls to audit afterwards. `reply` is always populated - even a refusal or
 * a plain question gets an answer, so the box never goes quiet.
 */
export const CommandSchema = z.object({
  reply: z.string().min(1),
  action: z.enum([
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
  ]),
  // nullish, not nullable: Gemini omits a field it has no value for rather
  // than sending an explicit null, and `.nullable()` still demands the key be
  // there - so a perfectly good "just answer the question" reply failed
  // validation on three fields it had no reason to fill in.
  /** The body to send, when the action is a send. */
  message: z.string().nullish(),
  /** "HH:MM" 24-hour, for set_contact_window. */
  window_start: z.string().nullish(),
  window_end: z.string().nullish(),
  /** "YYYY-MM-DD", for snooze. */
  snooze_until: z.string().nullish(),
  /** Free text recorded in the audit trail for the admin actions that take one. */
  reason: z.string().nullish(),
});

export type AgentCommand = z.infer<typeof CommandSchema>;

/** A one-line summary of a finished conversation, for the audit trail. */
export const SummarySchema = z.object({
  summary: z.string().min(1),
  needs_human: z.boolean(),
});

export type AgentSummary = z.infer<typeof SummarySchema>;

export interface DecisionProvider {
  /** Recorded in the audit trail so you can tell which brain made a call. */
  readonly name: string;
  readonly model: string;
  decide(system: string, user: string): Promise<AgentDecision>;
  /** The next turn of a customer conversation. */
  reply(system: string, user: string): Promise<AgentReply>;
  /** What that conversation amounted to, once it has gone quiet. */
  summarise(system: string, user: string): Promise<AgentSummary>;
  /** What an admin asked for in the case panel, and what to do about it. */
  command(system: string, user: string): Promise<AgentCommand>;
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
