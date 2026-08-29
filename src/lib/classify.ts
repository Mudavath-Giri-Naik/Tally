/**
 * Payment degradation -> root cause.
 *
 * Use case 1 in one file: a failed payment is not one thing. "Insufficient
 * funds" and "expired card" are both `payment.failed` to Razorpay, but one is
 * worth retrying in four days and the other can never succeed no matter how
 * many times you try it. Classifying correctly is what makes the difference
 * between a recovery agent and an autoresponder.
 *
 * Every root cause carries a profile that says what is *physically* possible -
 * whether a retry could ever work, and whose fault it was. The decision engine
 * may choose among the options this leaves open, but it cannot override these:
 * no prompt should be able to talk the system into retrying an expired card.
 */
import type { RootCause, EventType } from "./types";

export interface RootCauseProfile {
  /** Could a retry of the *same* payment method ever succeed? */
  retryable: boolean;
  /**
   * Was this the customer's problem, or the infrastructure's? Systemic
   * failures must never carry blaming language - the customer did nothing.
   */
  systemic: boolean;
  /** Retrying sooner than this is spam, not recovery. Hours. */
  minRetryDelayHours: number;
  /** Human-readable, used in the dashboard and the agent prompt. */
  label: string;
  /** What actually fixes this, in plain words. Feeds the agent's context. */
  remedy: string;
}

export const ROOT_CAUSE_PROFILES: Record<RootCause, RootCauseProfile> = {
  // Use case 8: money will exist later. Time the retry, do not hammer it.
  insufficient_funds: {
    retryable: true,
    systemic: false,
    minRetryDelayHours: 48,
    label: "Insufficient funds",
    remedy:
      "The account was short at the time. Retrying immediately fails again; " +
      "retry near a likely salary-credit date instead.",
  },
  // Use case 9: no number of retries fixes a dead card.
  card_expired: {
    retryable: false,
    systemic: false,
    minRetryDelayHours: 0,
    label: "Card expired",
    remedy: "Retrying cannot succeed. Ask for a different payment method.",
  },
  card_blocked: {
    retryable: false,
    systemic: false,
    minRetryDelayHours: 0,
    label: "Card blocked or restricted",
    remedy:
      "The issuer has blocked this card. Retrying cannot succeed - ask for a " +
      "different payment method.",
  },
  invalid_details: {
    retryable: true,
    systemic: false,
    minRetryDelayHours: 0,
    label: "Incorrect card details",
    remedy: "A typo. A fresh checkout link usually resolves it immediately.",
  },
  // Use case 11: a slip, not a decision. Just let them try again.
  otp_failed: {
    retryable: true,
    systemic: false,
    minRetryDelayHours: 0,
    label: "OTP not completed",
    remedy:
      "The customer did not finish the OTP step. A simple immediate retry " +
      "link is enough - no explanation needed.",
  },
  authentication_failed: {
    retryable: true,
    systemic: false,
    minRetryDelayHours: 0,
    label: "3DS authentication failed",
    remedy: "Bank verification did not complete. An immediate retry link usually works.",
  },
  // Use case 12: needs its own handling, not the domestic-decline script.
  international_declined: {
    retryable: false,
    systemic: false,
    minRetryDelayHours: 0,
    label: "International card declined",
    remedy:
      "The card is foreign-issued and was declined or is not enabled for " +
      "international/INR transactions. Suggest a domestic card or UPI rather " +
      "than a plain retry.",
  },
  // Use case 10: the customer did nothing wrong. Never blame them.
  gateway_timeout: {
    retryable: true,
    systemic: true,
    minRetryDelayHours: 1,
    label: "Gateway timeout",
    remedy:
      "A systemic failure on the payment rails, not the customer's fault. " +
      "Retry soon and apologise for the glitch - never imply their payment " +
      "was refused.",
  },
  issuer_down: {
    retryable: true,
    systemic: true,
    minRetryDelayHours: 3,
    label: "Bank temporarily unavailable",
    remedy:
      "The customer's bank was unreachable. Not the customer's fault. Retry " +
      "once the bank is back.",
  },
  risk_declined: {
    retryable: false,
    systemic: false,
    minRetryDelayHours: 0,
    label: "Declined by risk checks",
    remedy:
      "Blocked by fraud/risk rules. Do not automate around this - a human " +
      "should look at it.",
  },
  mandate_revoked: {
    retryable: false,
    systemic: false,
    minRetryDelayHours: 0,
    label: "Mandate revoked",
    remedy:
      "The customer cancelled the AutoPay mandate. Auto-debit cannot be " +
      "retried; a new mandate must be authorised.",
  },
  mandate_limit_exceeded: {
    retryable: false,
    systemic: false,
    minRetryDelayHours: 0,
    label: "Amount exceeds mandate limit",
    remedy:
      "The charge is larger than the mandate the customer approved. Needs a " +
      "new mandate at a higher limit, or a one-off payment.",
  },
  customer_abandoned: {
    retryable: true,
    systemic: false,
    minRetryDelayHours: 0,
    label: "Checkout abandoned",
    remedy: "Nothing failed - the customer simply did not finish. Bring them back.",
  },
  invoice_unpaid: {
    retryable: true,
    systemic: false,
    minRetryDelayHours: 24,
    label: "Invoice unpaid",
    remedy: "A B2B receivable past its due date. Chase on a schedule.",
  },
  unknown: {
    retryable: true,
    systemic: false,
    minRetryDelayHours: 6,
    label: "Unknown failure",
    remedy:
      "The cause could not be determined. Be cautious and non-specific - do " +
      "not guess at a reason in the message to the customer.",
  },
};

/**
 * Razorpay reports a failure across several fields and its vocabulary is not
 * stable across methods (cards, UPI, netbanking, mandates). Rather than match
 * one field exactly, we score the whole error surface against known markers.
 *
 * Ordering matters: the first matching rule wins, so the specific patterns
 * (mandate, international) are checked before the generic ones (card declined).
 */
interface Rule {
  cause: RootCause;
  /** Matched against error_reason / error_code / error_description, lowercased. */
  patterns: RegExp[];
}

const RULES: Rule[] = [
  // --- mandate / AutoPay specific: check first, they mention "card" too ---
  {
    cause: "mandate_revoked",
    patterns: [
      /mandate[_ ]?(revoked|cancelled|canceled|paused|stopped)/,
      /subscription[_ ]?(cancelled|canceled)/,
      /upi[_ ]?mandate[_ ]?(revoked|paused)/,
    ],
  },
  {
    cause: "mandate_limit_exceeded",
    patterns: [
      /(amount|debit)[_ ]?(exceeds|greater than|more than)[_ ]?(mandate|limit)/,
      /mandate[_ ]?(limit|amount)[_ ]?exceeded/,
      /exceeds[_ ]?mandate/,
    ],
  },

  // --- international: before generic card decline ---
  {
    cause: "international_declined",
    patterns: [
      /international[_ ]?(transaction|card|payment)?[_ ]?not[_ ]?(allowed|supported|enabled)/,
      /international[_ ]?(card[_ ]?)?declin/,
      /foreign[_ ]?card/,
      /cross[_ ]?border/,
    ],
  },

  // --- risk: before generic decline, never auto-nudge around fraud ---
  {
    cause: "risk_declined",
    patterns: [
      /fraud/,
      /risk[_ ]?(declin|block|reject)/,
      /suspicious/,
      /blocked[_ ]?by[_ ]?(risk|issuer[_ ]?risk)/,
    ],
  },

  // --- funds ---
  {
    cause: "insufficient_funds",
    patterns: [
      /insufficient[_ ]?(funds|balance)/,
      /not[_ ]?enough[_ ]?(funds|balance|money)/,
      /low[_ ]?balance/,
      /\bnsf\b/,
      /exceeds[_ ]?(withdrawal|balance)/,
    ],
  },

  // --- card lifecycle ---
  {
    cause: "card_expired",
    patterns: [/card[_ ]?(has[_ ]?)?expired/, /expired[_ ]?card/, /\bexpiry\b.*\bpast\b/],
  },
  {
    cause: "card_blocked",
    patterns: [
      /card[_ ]?(is[_ ]?)?(blocked|restricted|disabled|inactive|frozen)/,
      /blocked[_ ]?card/,
      /card[_ ]?not[_ ]?(activated|permitted|allowed)/,
      /lost[_ ]?or[_ ]?stolen/,
      /do[_ ]?not[_ ]?honou?r/,
    ],
  },
  {
    cause: "invalid_details",
    patterns: [
      /invalid[_ ]?(card|number|cvv|expiry|account|vpa|upi)/,
      /incorrect[_ ]?(card|number|cvv|expiry|details|vpa)/,
      /card[_ ]?number[_ ]?(is[_ ]?)?(invalid|incorrect)/,
      /vpa[_ ]?(invalid|not[_ ]?found)/,
    ],
  },

  // --- authentication ---
  {
    cause: "otp_failed",
    patterns: [
      /otp/,
      /one[_ ]?time[_ ]?password/,
      /verification[_ ]?code/,
    ],
  },
  {
    cause: "authentication_failed",
    patterns: [
      /3ds|three[_ ]?d[_ ]?secure/,
      /authentication[_ ]?(failed|error|not[_ ]?completed)/,
      /auth[_ ]?(failed|declined)/,
      /customer[_ ]?(cancelled|canceled)[_ ]?(the[_ ]?)?(payment|transaction)/,
    ],
  },

  // --- infrastructure: not the customer's fault ---
  {
    cause: "issuer_down",
    patterns: [
      /issuer[_ ]?(down|unavailable|not[_ ]?available|unreachable)/,
      /bank[_ ]?(down|unavailable|not[_ ]?responding|server)/,
      /upi[_ ]?(down|unavailable)/,
      /psp[_ ]?(down|error)/,
    ],
  },
  {
    cause: "gateway_timeout",
    patterns: [
      /timed?[_ ]?out/,
      /timeout/,
      /gateway[_ ]?(error|failure|unavailable)/,
      /network[_ ]?error/,
      /temporar(y|ily)[_ ]?(unavailable|error|failure)/,
      /server[_ ]?error/,
      /try[_ ]?again[_ ]?later/,
    ],
  },
];

/** The Razorpay error surface we classify against. */
export interface RazorpayErrorSurface {
  error_code?: string | null;
  error_description?: string | null;
  error_reason?: string | null;
  error_source?: string | null;
  error_step?: string | null;
}

/**
 * Classify a failure into its root cause.
 *
 * Unrecognised failures return `unknown` rather than a guess: the agent is
 * told to stay non-specific in that case, which is far better than confidently
 * telling a customer their card expired when it did not.
 */
export function classifyFailure(err: RazorpayErrorSurface): RootCause {
  const haystack = [
    err.error_reason,
    err.error_code,
    err.error_description,
    err.error_step,
  ]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" | ")
    .toLowerCase();

  if (haystack === "") return "unknown";

  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(haystack))) {
      return rule.cause;
    }
  }

  // A bare BANK_ERROR / GATEWAY_ERROR with no detail is still systemic.
  if (/bank_error|gateway_error/.test(haystack)) return "gateway_timeout";

  return "unknown";
}

/** The default root cause for events that are not payment failures at all. */
export function defaultCauseForType(type: EventType): RootCause {
  switch (type) {
    case "cart_abandoned":
      return "customer_abandoned";
    case "receivable_overdue":
      return "invoice_unpaid";
    case "promise_to_pay":
      return "invoice_unpaid";
    default:
      return "unknown";
  }
}

export function profileFor(cause: RootCause): RootCauseProfile {
  return ROOT_CAUSE_PROFILES[cause] ?? ROOT_CAUSE_PROFILES.unknown;
}
