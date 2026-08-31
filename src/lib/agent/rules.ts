/**
 * Guardrails.
 *
 * The model chooses *how* to recover. This file decides what is permitted at
 * all, and it runs on both sides of the model: a preflight that can stop an
 * event before any tokens are spent, and a clamp that constrains whatever the
 * model returned.
 *
 * Everything here is deterministic and unit-tested. No prompt should be able
 * to talk Tally into messaging someone who opted out, retrying a card that
 * cannot work, or calling a customer at 3am - so those decisions are not the
 * model's to make.
 */
import type {
  Merchant,
  RecoveryEvent,
  Customer,
  Action,
  Channel,
  Intervention,
  DecisionRecord,
} from "../types";
import { profileFor } from "../classify";

/** Above this, a failure gets faster, more careful escalation (use case 15). */
export const HIGH_VALUE_PAISE = 500_000; // Rs 5,000

/**
 * After this many failures across billing cycles, automation has demonstrably
 * stopped working on this customer. Hand them to a human (use case 14).
 */
export const REPEAT_FAILURE_ESCALATION_THRESHOLD = 3;

export interface DecisionContext {
  merchant: Merchant;
  event: RecoveryEvent;
  customer: Customer | null;
  priorActions: Action[];
  siblingEvents: RecoveryEvent[];
  priorFailureCount: number;
  now: Date;
}

export interface Stop {
  intervention: "stop" | "escalate_human";
  stopReason: string;
  rationale: string;
}

// ─── timezone-aware contact window ──────────────────────────────────────────

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function localParts(at: Date, timeZone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(at)) {
    if (part.type !== "literal") p[part.type] = part.value;
  }
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

/**
 * Offset of `timeZone` from UTC at `at`, in ms. Derived by formatting the
 * instant in that zone and comparing - avoids pulling in a tz library for the
 * one thing we need it for.
 */
function tzOffsetMs(at: Date, timeZone: string): number {
  const p = localParts(at, timeZone);
  const asIfUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUTC - Math.floor(at.getTime() / 1000) * 1000;
}

/** Turn a local wall-clock time in `timeZone` into a real UTC instant. */
function localWallClockToUTC(
  parts: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): Date {
  const naive = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    0,
  );
  // Offset sampled at the naive instant. Exact for zones without DST (IST),
  // and at worst an hour out for one transition night elsewhere.
  const offset = tzOffsetMs(new Date(naive), timeZone);
  return new Date(naive - offset);
}

function parseTime(hhmmss: string): { hour: number; minute: number } {
  const [h, m] = hhmmss.split(":");
  return { hour: Number(h), minute: Number(m ?? 0) };
}

/** Is it currently inside the merchant's permitted contact window? */
export function withinContactWindow(merchant: Merchant, now: Date): boolean {
  const local = localParts(now, merchant.timezone);
  const start = parseTime(merchant.contact_window_start);
  const end = parseTime(merchant.contact_window_end);

  const minutes = local.hour * 60 + local.minute;
  const startMin = start.hour * 60 + start.minute;
  const endMin = end.hour * 60 + end.minute;

  // A window that wraps midnight (e.g. 22:00-06:00) is unusual but legal.
  if (startMin <= endMin) return minutes >= startMin && minutes < endMin;
  return minutes >= startMin || minutes < endMin;
}

/** The next instant the contact window opens. */
export function nextWindowOpen(merchant: Merchant, now: Date): Date {
  if (withinContactWindow(merchant, now)) return now;

  const local = localParts(now, merchant.timezone);
  const start = parseTime(merchant.contact_window_start);
  const startMin = start.hour * 60 + start.minute;
  const nowMin = local.hour * 60 + local.minute;

  // Later today if the window has not opened yet, otherwise tomorrow.
  const dayOffset = nowMin < startMin ? 0 : 1;
  const target = new Date(
    Date.UTC(local.year, local.month - 1, local.day + dayOffset),
  );
  const t = localParts(target, "UTC");

  return localWallClockToUTC(
    { year: t.year, month: t.month, day: t.day, hour: start.hour, minute: start.minute },
    merchant.timezone,
  );
}

// ─── retry scheduling ───────────────────────────────────────────────────────

/**
 * Use case 8: money appears when salaries land. Retrying an
 * insufficient-funds failure three hours later just burns the customer's
 * patience and the merchant's gateway fees.
 *
 * Indian payroll clusters on the 1st, the 7th and the 15th. Aim for the next
 * one at least `minDelayHours` away, at 10:00 local - after the credit has
 * typically settled.
 */
const SALARY_DAYS = [1, 7, 15];

export function nextSalaryCreditWindow(
  now: Date,
  timeZone: string,
  minDelayHours: number,
): Date {
  const earliest = new Date(now.getTime() + minDelayHours * 3600_000);
  const local = localParts(earliest, timeZone);

  for (let monthOffset = 0; monthOffset <= 2; monthOffset++) {
    for (const day of SALARY_DAYS) {
      const candidate = localWallClockToUTC(
        {
          year: local.year,
          month: local.month + monthOffset,
          day,
          hour: 10,
          minute: 0,
        },
        timeZone,
      );
      if (candidate.getTime() >= earliest.getTime()) return candidate;
    }
  }
  return earliest;
}

/**
 * Use case 5: a mandate retry sequence, not random retries. Spacing widens
 * with each attempt, and the last attempt waits for payday.
 */
export function mandateRetrySchedule(
  attempts: number,
  now: Date,
  timeZone: string,
): Date {
  switch (attempts) {
    case 0:
      return new Date(now.getTime() + 24 * 3600_000);
    case 1:
      return new Date(now.getTime() + 72 * 3600_000);
    default:
      return nextSalaryCreditWindow(now, timeZone, 96);
  }
}

/** When should this event next be attempted, given why it failed? */
export function computeNextAttempt(ctx: DecisionContext): Date {
  const { event, merchant, now } = ctx;
  const profile = profileFor(event.reason ?? "unknown");

  if (event.type === "mandate_retry") {
    return mandateRetrySchedule(event.attempts, now, merchant.timezone);
  }
  if (event.reason === "insufficient_funds") {
    return nextSalaryCreditWindow(now, merchant.timezone, profile.minRetryDelayHours);
  }

  // Otherwise back off exponentially from the cause's minimum, so a systemic
  // outage is retried soon but not in a tight loop.
  const base = Math.max(profile.minRetryDelayHours, 1);
  const hours = base * Math.pow(2, event.attempts);
  return new Date(now.getTime() + Math.min(hours, 168) * 3600_000);
}

// ─── preflight: reasons to never contact at all ─────────────────────────────

/**
 * Runs before the model. Returns a Stop when the event must not proceed - no
 * tokens spent, no message sent.
 */
export function preflight(ctx: DecisionContext): Stop | null {
  const { merchant, event, customer, priorFailureCount } = ctx;

  if (customer?.opted_out) {
    return {
      intervention: "stop",
      stopReason: "customer_opted_out",
      rationale:
        "The customer has opted out of contact. Stopping immediately, with no message sent.",
    };
  }

  if (!customer || (!customer.email && !customer.phone)) {
    return {
      intervention: "stop",
      stopReason: "no_contact_details",
      rationale:
        "No email or phone is known for this customer, so there is no way to reach them.",
    };
  }

  if (event.attempts >= merchant.max_attempts) {
    return {
      intervention: "stop",
      stopReason: "max_attempts_reached",
      rationale:
        `Already attempted ${event.attempts} times, and this merchant's limit is ` +
        `${merchant.max_attempts}. Continuing would be harassment, not recovery.`,
    };
  }

  const profile = profileFor(event.reason ?? "unknown");

  if (event.reason === "risk_declined") {
    return {
      intervention: "escalate_human",
      stopReason: "risk_flagged",
      rationale:
        "The payment was blocked by fraud/risk checks. Automating around a risk " +
        "decision is exactly the wrong response - a person needs to look at this.",
    };
  }

  // Use case 14: repeated failure across billing cycles.
  if (priorFailureCount >= REPEAT_FAILURE_ESCALATION_THRESHOLD) {
    return {
      intervention: "escalate_human",
      stopReason: "repeat_failure_across_cycles",
      rationale:
        `This customer has failed ${priorFailureCount} times in recent cycles. ` +
        "Automated nudging has not worked; a human should take over.",
    };
  }

  if (merchant.channels_enabled.length === 0) {
    return {
      intervention: "stop",
      stopReason: "no_channels_enabled",
      rationale: "The merchant has no channels enabled, so nothing can be sent.",
    };
  }

  void profile;
  return null;
}

// ─── which channels are actually usable right now ───────────────────────────

export function availableChannels(ctx: DecisionContext): Channel[] {
  const { merchant, customer, event } = ctx;
  const enabled = new Set(merchant.channels_enabled);
  const out: Channel[] = [];

  if (enabled.has("email") && customer?.email) out.push("email");
  if (enabled.has("whatsapp") && customer?.phone) out.push("whatsapp");
  if (enabled.has("voice") && customer?.phone) out.push("voice");

  // Don't repeat the exact same channel twice in a row - if email did not
  // work, escalate rather than send another email.
  const lastSent = [...ctx.priorActions]
    .reverse()
    .find((a) => a.outcome === "sent" || a.outcome === "delivered");
  if (lastSent?.channel && out.length > 1) {
    const escalated = out.filter((c) => c !== lastSent.channel);
    if (escalated.length > 0) return escalated;
  }
  return out;
}

/**
 * Use case 15: a large failure escalates faster. Voice on the first attempt
 * for a big invoice is proportionate; for Rs 200 it is not.
 */
export function isHighValue(event: RecoveryEvent): boolean {
  return (event.amount ?? 0) >= HIGH_VALUE_PAISE;
}

// ─── clamp: constrain whatever the model returned ───────────────────────────

export interface AgentChoice {
  intervention: Intervention;
  channel: Channel | null;
  message: string;
  rationale: string;
}

export interface ClampedDecision extends DecisionRecord {
  message: string;
  send: boolean;
  scheduledFor: Date | null;
}

/**
 * Force the model's choice into the set of things that are actually allowed.
 * Any override is recorded in `guardrail` so the audit trail shows both what
 * the agent wanted and why it did not happen.
 */
export function clamp(
  choice: AgentChoice,
  ctx: DecisionContext,
): ClampedDecision {
  const { event, merchant, now } = ctx;
  const cause = event.reason ?? "unknown";
  const profile = profileFor(cause);
  const usable = availableChannels(ctx);

  let intervention = choice.intervention;
  let channel = choice.channel;
  let guardrail: string | undefined;
  let scheduledFor: Date | null = null;

  // A retry of a payment method that physically cannot work is never allowed,
  // no matter how confident the model is.
  if (intervention === "schedule_retry" && !profile.retryable) {
    intervention = "request_new_method";
    guardrail = `${cause} is not retryable - asked for a new payment method instead of retrying`;
  }

  // Sending requires a channel that exists and is reachable.
  if (intervention === "send_message" || intervention === "request_new_method") {
    if (usable.length === 0) {
      intervention = "stop";
      channel = null;
      guardrail = "no usable channel for this customer";
    } else if (!channel || !usable.includes(channel)) {
      const preferred = isHighValue(event)
        ? (["voice", "whatsapp", "email"] as Channel[])
        : (["whatsapp", "email", "voice"] as Channel[]);
      const fallback = preferred.find((c) => usable.includes(c)) ?? usable[0];
      guardrail =
        guardrail ??
        `channel ${channel ?? "none"} unavailable - fell back to ${fallback}`;
      channel = fallback;
    }
  }

  // The compliance window. A message that would land outside it is deferred to
  // the moment it opens, not dropped.
  if (
    (intervention === "send_message" || intervention === "request_new_method") &&
    !withinContactWindow(merchant, now)
  ) {
    scheduledFor = nextWindowOpen(merchant, now);
    // A short code for the badge, not the ISO timestamp that used to live
    // here - "outside the 09:00-21:00 Asia/Kolkata contact window - deferred
    // to 2026-09-01T03:30:00.000Z" crammed into a small pill read as noise,
    // not as an answer to "why hasn't anything happened". The actual answer
    // - in the merchant's own timezone, not raw UTC - belongs in the
    // rationale a merchant actually reads, replacing the agent's now-stale
    // "here is what I was about to send" reasoning for this deferred step.
    guardrail = "outside_contact_window";
    const scheduledLocal = scheduledFor.toLocaleString("en-IN", {
      timeZone: merchant.timezone,
      dateStyle: "medium",
      timeStyle: "short",
    });
    return {
      root_cause: cause,
      intervention: "schedule_retry",
      channel,
      message: choice.message,
      rationale:
        `Outside the ${merchant.contact_window_start}–${merchant.contact_window_end} ` +
        `${merchant.timezone} contact window. The next attempt is scheduled for ` +
        `${scheduledLocal}.`,
      guardrail,
      source: "guardrail",
      send: false,
      scheduledFor,
      scheduled_for: scheduledFor.toISOString(),
    };
  }

  if (intervention === "schedule_retry") {
    scheduledFor = computeNextAttempt(ctx);
  }

  return {
    root_cause: cause,
    intervention,
    channel: intervention === "stop" || intervention === "escalate_human" ? null : channel,
    message: choice.message,
    rationale: choice.rationale,
    guardrail,
    source: guardrail ? "guardrail" : "agent",
    send: intervention === "send_message" || intervention === "request_new_method",
    scheduledFor,
    scheduled_for: scheduledFor ? scheduledFor.toISOString() : null,
  };
}
