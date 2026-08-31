/**
 * The decision step.
 *
 * A model picks the intervention and writes the copy; `clamp` in rules.ts then
 * constrains that choice to what is actually permitted. The model is never the
 * last word - it proposes, the guardrails dispose.
 *
 * Which model is a configuration detail (see providers/index.ts). If none is
 * configured, or the call fails, `fallbackChoice` produces a competent
 * templated decision from the root cause alone: recovery keeps working during
 * an outage, it just stops being clever.
 */
import { profileFor } from "../classify";
import { formatINR } from "../types";
import type { Channel } from "../types";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt";
import { getProvider, type AgentDecision } from "./providers";
import { providerFor } from "./rotating";
import {
  clamp,
  availableChannels,
  isHighValue,
  type DecisionContext,
  type AgentChoice,
  type ClampedDecision,
} from "./rules";

export type { AgentDecision };

export interface DecisionResult extends ClampedDecision {
  subject: string | null;
  /** True when no model was consulted and a template was used instead. */
  usedFallback: boolean;
}

/**
 * A competent decision without a model. Used when no provider is configured,
 * or when the call fails - an outage must not stall recovery.
 */
export function fallbackChoice(ctx: DecisionContext): AgentChoice & {
  subject: string | null;
} {
  const { event, merchant, customer } = ctx;
  const profile = profileFor(event.reason ?? "unknown");
  const amount = formatINR(event.amount);
  const name = customer?.name ? ` ${customer.name}` : "";
  const usable = availableChannels(ctx);

  // Match the escalation preference the guardrails apply when the model
  // declines to pick. Without this the fallback always reaches for whatever
  // happens to be first, and a large failure gets the same quiet email as a
  // small one (use case 15).
  const preference: Channel[] = isHighValue(event)
    ? ["voice", "whatsapp", "email"]
    : ["whatsapp", "email", "voice"];
  const channels = [
    ...preference.filter((c) => usable.includes(c)),
    ...usable.filter((c) => !preference.includes(c)),
  ];

  if (!profile.retryable) {
    return {
      intervention: "request_new_method",
      channel: channels[0] ?? null,
      subject: `Payment of ${amount} to ${merchant.business_name} could not be completed`,
      message:
        `Hi${name}, your payment of ${amount} to ${merchant.business_name} could not be completed ` +
        `(${profile.label.toLowerCase()}). Retrying the same method will not work - please use a ` +
        `different card or UPI to complete it.`,
      rationale: `Templated fallback: ${event.reason} cannot be recovered by retrying.`,
    };
  }

  if (profile.systemic) {
    return {
      intervention: "send_message",
      channel: channels[0] ?? null,
      subject: `Sorry - a problem processing your ${amount} payment`,
      message:
        `Hi${name}, sorry - a technical problem on our side stopped your payment of ${amount} to ` +
        `${merchant.business_name} from going through. Nothing was wrong with your card. ` +
        `You can complete it here whenever convenient.`,
      rationale:
        "Templated fallback: systemic failure, apologise and do not blame the customer.",
    };
  }

  if (event.reason === "insufficient_funds") {
    return {
      intervention: "schedule_retry",
      channel: channels[0] ?? null,
      subject: `Your ${amount} payment to ${merchant.business_name} did not go through`,
      message:
        `Hi${name}, your payment of ${amount} to ${merchant.business_name} did not go through. ` +
        `No rush - you can complete it whenever you are ready.`,
      rationale:
        "Templated fallback: insufficient funds, wait for a likely salary credit before retrying.",
    };
  }

  return {
    intervention: "send_message",
    channel: channels[0] ?? null,
    subject: `Your ${amount} payment to ${merchant.business_name} did not go through`,
    message:
      `Hi${name}, your payment of ${amount} to ${merchant.business_name} did not go through. ` +
      `You can complete it using the link below.`,
    rationale: `Templated fallback for ${event.reason}.`,
  };
}

/**
 * Decide what to do about one event.
 *
 * Always returns a decision. Never throws for model-side reasons - a failed
 * call degrades to the template rather than leaving the event stuck.
 */
export async function decide(ctx: DecisionContext): Promise<DecisionResult> {
  let choice: AgentChoice;
  let subject: string | null = null;
  let usedFallback = false;
  let model: string | undefined;

  let provider = null;
  try {
    provider = await providerFor(ctx.merchant);
  } catch (err) {
    // A misconfigured TALLY_LLM_PROVIDER should be loud, not silent.
    console.error("[agent] provider selection failed", err);
  }

  if (!provider) {
    const fb = fallbackChoice(ctx);
    subject = fb.subject;
    choice = fb;
    usedFallback = true;
  } else {
    try {
      const parsed = await provider.decide(SYSTEM_PROMPT, buildUserPrompt(ctx));
      subject = parsed.subject;
      model = `${provider.name}:${provider.model}`;
      choice = {
        intervention: parsed.intervention,
        channel: parsed.channel as Channel | null,
        message: parsed.message,
        rationale: parsed.rationale,
      };
    } catch (err) {
      console.error(
        `[agent] ${provider.name} decision failed, using template fallback`,
        err instanceof Error ? err.message : err,
      );
      const fb = fallbackChoice(ctx);
      subject = fb.subject;
      choice = fb;
      usedFallback = true;
    }
  }

  const clamped = clamp(choice, ctx);

  return {
    ...clamped,
    subject,
    usedFallback,
    model,
    source: usedFallback && !clamped.guardrail ? "schedule" : clamped.source,
  };
}

export { isHighValue };
