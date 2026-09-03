/**
 * The whole life of one case, as numbered steps.
 *
 * The timeline below it tells the story in cards: what was said, to whom, and
 * why. This answers a different and simpler question - where has this got to,
 * and what is happening to it right now. A merchant watching a case they just
 * triggered wants a progress bar, not a narrative, and reading state out of a
 * stack of cards is work they should not have to do.
 *
 * Derived entirely from the event and its recorded actions. Nothing here is
 * inferred optimistically or assumed to have happened: every step that claims
 * to be done is backed by a row that says so. A step Tally cannot prove
 * reached is drawn as pending, which is why the arrival steps are the only
 * ones that are unconditional - the case existing at all is proof the webhook
 * arrived, was verified, was classified and was written down.
 */
import type { BoardRow, TimelineEntry } from "./board";
import {
  ADMIN_ASK_PREFIX,
  ADMIN_REPLY_PREFIX,
  INBOUND_PREFIX,
  REPLY_PREFIX,
  SUMMARY_PREFIX,
} from "./board";

/**
 * done    - it happened, and there is a row proving it
 * active  - happening now, or the thing the case is sitting on
 * waiting - scheduled, deliberately not happening yet
 * failed  - it was tried and did not work
 * skipped - deliberately not done
 * pending - not reached yet
 */
export type StepState = "done" | "active" | "waiting" | "failed" | "skipped" | "pending";

export interface JourneyStep {
  n: number;
  /** Plain words. No jargon a merchant would have to look up. */
  title: string;
  detail: string | null;
  /** The short status chip - a code, an outcome, or a countdown. */
  code: string;
  state: StepState;
  at: string | null;
}

/** Stop reasons in the words a merchant would use, not the code's. */
const STOP_WORDS: Record<string, string> = {
  customer_opted_out: "They asked us to stop",
  no_contact_details: "No email or phone on file",
  holdout_control: "Held back on purpose, as a control",
  max_attempts_reached: "Reached your attempt limit",
  risk_flagged: "Fraud checks blocked it",
  repeat_failure_across_cycles: "Failed too many times",
  no_channels_enabled: "No channels switched on",
  workflow_disabled: "This kind of recovery is switched off",
  agent_chose_stop: "Agent judged more contact pointless",
  escalated_to_human: "Handed to a person",
  admin_escalated: "You escalated it",
  admin_disputed: "You flagged it as disputed",
  admin_written_off: "You wrote it off",
  customer_claims_paid: "They say they already paid",
  merchant_missing: "Business record missing",
};

/**
 * The merchant's own overrides, in the second person.
 *
 * These are not decisions Tally made, and describing them as though they were
 * is the fastest way to lose someone's trust in the rest of the strip - a
 * merchant who sees their own click reported back as "a rule stopped it" now
 * has grounds to doubt every other line.
 */
const ADMIN_WORDS: Record<string, string> = {
  mark_paid: "You marked it as paid",
  pause_outreach: "You paused outreach",
  resume_outreach: "You resumed outreach",
  escalate_human: "You handed it to a person",
  flag_disputed: "You flagged it as disputed",
  snooze: "You snoozed it",
  trigger_next_step: "You triggered the next step",
  write_off: "You wrote it off",
  opt_out: "You opted the customer out",
  reopen_case: "You reopened the case",
};

const CHANNEL_WORDS: Record<string, string> = {
  email: "an email",
  whatsapp: "a WhatsApp message",
  voice: "a phone call",
};

/** "in 2h 10m", "in 3 days", "now" - a countdown, not a timestamp. */
export function countdown(iso: string, now: Date): string {
  const ms = new Date(iso).getTime() - now.getTime();
  if (ms <= 0) return "due now";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

function isConversation(message: string | null): boolean {
  if (!message) return false;
  return (
    message.startsWith(INBOUND_PREFIX) ||
    message.startsWith(REPLY_PREFIX) ||
    message.startsWith(ADMIN_ASK_PREFIX) ||
    message.startsWith(ADMIN_REPLY_PREFIX) ||
    message.startsWith(SUMMARY_PREFIX)
  );
}

/**
 * Build the step list.
 *
 * `now` is a parameter rather than read inside, so the countdowns are stable
 * within one render and the whole thing can be tested at a fixed instant.
 */
export function buildJourney(
  row: BoardRow,
  entries: TimelineEntry[],
  now: Date = new Date(),
): JourneyStep[] {
  const steps: JourneyStep[] = [];
  let n = 0;
  const push = (s: Omit<JourneyStep, "n">) => {
    steps.push({ n: ++n, ...s });
  };

  /* ── it arrived ───────────────────────────────────────────────────────── */

  push({
    title: "The payment failed",
    detail: row.order_id ? `Razorpay order ${row.order_id}` : null,
    code: "FAILED",
    state: "done",
    at: row.failed_on,
  });

  push({
    title: "Razorpay told Tally",
    detail: "Signature checked, event accepted",
    code: "200 OK",
    state: "done",
    at: row.failed_on,
  });

  push({
    title: "Tally worked out why it failed",
    detail: row.reason_retryable
      ? `${row.reason_label} — trying again can work`
      : `${row.reason_label} — trying the same method again cannot work`,
    code: "SORTED",
    state: "done",
    at: row.failed_on,
  });

  push({
    title: "The customer was matched",
    detail: row.customer_email ?? row.customer_phone ?? "No contact details",
    code: row.customer_email || row.customer_phone ? "FOUND" : "MISSING",
    state: row.customer_email || row.customer_phone ? "done" : "failed",
    at: row.failed_on,
  });

  push({
    title: "The case was opened",
    detail: "Queued for the agent. Nothing sent yet",
    code: "QUEUED",
    state: "done",
    at: row.failed_on,
  });

  /* ── what the agent did, attempt by attempt ───────────────────────────── */

  const acted = entries.filter((e) => !isConversation(e.message));
  const inbound = entries.filter((e) => e.message?.startsWith(INBOUND_PREFIX));

  const isSend = (e: TimelineEntry) =>
    e.channel !== null &&
    (e.outcome === "sent" || e.outcome === "delivered" || e.outcome === "failed");

  /**
   * Every recorded action becomes a step, whatever kind it was.
   *
   * The first version only understood sends and hard stops, so a tick that
   * looked at the case and deliberately held off - a sibling event already
   * messaged this person, the contact window was shut - produced no step at
   * all. The strip then jumped from "case opened" straight to "waiting", which
   * reads as nothing having happened when in fact the agent had considered it
   * and decided. A deliberate decision not to act is a step; leaving it out is
   * how a progress view starts quietly lying about how much work was done.
   */
  const gotPastPreflight = acted.some((e) => isSend(e) || e.outcome === "skipped");

  if (acted.length > 0) {
    push({
      title: "The worker picked it up",
      detail: "Claimed for processing",
      code: "CLAIMED",
      state: "done",
      at: acted[0].created_at,
    });

    if (gotPastPreflight) {
      push({
        title: "Safety checks passed",
        detail: "Not opted out, reachable, under your attempt limit",
        code: "CLEAR",
        state: "done",
        at: acted[0].created_at,
      });
    }
  }

  let attempt = 0;

  for (const a of acted) {
    if (a.admin_action) {
      push({
        title: ADMIN_WORDS[a.admin_action] ?? "You acted on this case",
        detail: a.rationale,
        code: "BY YOU",
        state: "done",
        at: a.created_at,
      });
    } else if (isSend(a)) {
      attempt++;
      const channel = CHANNEL_WORDS[a.channel ?? ""] ?? "a message";
      const failed = a.outcome === "failed";

      push({
        title: `Attempt ${attempt} — the agent chose ${channel}`,
        detail: a.rationale,
        code: a.source === "guardrail" ? "RULE" : "AGENT",
        state: "done",
        at: a.created_at,
      });

      if (a.guardrail) {
        push({
          title: "A guardrail adjusted it",
          detail: a.guardrail.replace(/_/g, " "),
          code: "RULE",
          state: "done",
          at: a.created_at,
        });
      }

      push({
        title: failed
          ? `Attempt ${attempt} could not be sent`
          : `Attempt ${attempt} was sent`,
        detail: failed
          ? (a.response ?? "The provider refused it")
          : `To ${a.sent_to ?? row.customer_email ?? row.customer_phone ?? "the customer"}` +
            (a.in_window === false ? " — outside your contact window" : ""),
        code: failed ? "FAILED" : a.outcome === "delivered" ? "DELIVERED" : "SENT",
        state: failed ? "failed" : "done",
        at: a.sent_at ?? a.created_at,
      });
    } else if (a.outcome === "skipped") {
      push({
        title: "The agent held off this time",
        detail: a.rationale ?? a.guardrail?.replace(/_/g, " ") ?? "Nothing was sent on this pass",
        code: "HELD",
        state: "skipped",
        at: a.created_at,
      });
    } else if (a.outcome === "no_action" || a.outcome === "escalated") {
      push({
        title:
          a.outcome === "escalated"
            ? "A rule handed it to a person"
            : "A rule stopped it here",
        detail: a.rationale ?? "Nothing was sent",
        code: a.outcome === "escalated" ? "ESCALATED" : "STOPPED",
        state: "skipped",
        at: a.created_at,
      });
    }
  }

  inbound.forEach((reply) => {
    push({
      title: "They replied",
      detail: reply.message?.slice(INBOUND_PREFIX.length) ?? null,
      code: "REPLY",
      state: "done",
      at: reply.created_at,
    });
  });

  /* ── where it is right now ────────────────────────────────────────────── */

  const finished =
    row.status === "recovered" ||
    row.status === "stopped" ||
    row.status === "opted_out" ||
    row.status === "written_off" ||
    row.status === "disputed" ||
    row.status === "needs_human";

  if (!finished) {
    if (row.paused) {
      push({
        title: "Paused by you",
        detail: "Nothing goes out until you resume it",
        code: "PAUSED",
        state: "waiting",
        at: null,
      });
    } else if (row.hold_until) {
      push({
        title: "Snoozed by you",
        detail: `Picks back up ${countdown(row.hold_until, now)}`,
        code: "SNOOZED",
        state: "waiting",
        at: row.hold_until,
      });
    } else if (row.next_attempt_at) {
      const due = new Date(row.next_attempt_at).getTime() <= now.getTime();
      push({
        title: due ? "Working on the next attempt" : "Waiting for the next attempt",
        detail: due
          ? "The worker is picking this up now"
          : `Attempt ${row.attempts + 1} of ${row.max_attempts}, ${countdown(row.next_attempt_at, now)}`,
        // The one genuinely live row. It is the answer to "what is happening
        // to my money right now", which is the only question being asked by
        // somebody who has just triggered a failure and is watching.
        code: due ? "RUNNING" : "WAITING",
        state: due ? "active" : "waiting",
        at: row.next_attempt_at,
      });
    } else {
      push({
        title: "Waiting for them to pay",
        detail: "The link is live. Nothing further is scheduled",
        code: "OPEN",
        state: "active",
        at: null,
      });
    }

    push({
      title: "Payment confirmed",
      detail: "Waiting on Razorpay to confirm the money moved",
      code: "PENDING",
      state: "pending",
      at: null,
    });
    return steps;
  }

  /* ── how it ended ─────────────────────────────────────────────────────── */

  if (row.status === "recovered") {
    // Closed by hand or closed by Razorpay are two different claims, and only
    // one of them is evidence. Saying "Razorpay confirmed the money moved"
    // over a case a merchant closed themselves would put words in Razorpay's
    // mouth - on the very line the recovery figure is built from.
    const byHand = acted.some((e) => e.admin_action === "mark_paid");
    push({
      title: byHand ? "Marked as paid" : "They paid",
      detail: byHand
        ? "Closed by you, not by a payment confirmation"
        : "Razorpay confirmed the money moved. Chasing stopped",
      code: "RECOVERED",
      state: "done",
      at: row.recovered_at,
    });
  } else if (row.status === "needs_human") {
    push({
      title: "Handed to a person",
      detail: STOP_WORDS[row.stop_reason ?? ""] ?? "This needs someone to look at it",
      code: "ESCALATED",
      state: "waiting",
      at: null,
    });
  } else {
    push({
      title: "Stopped",
      detail: STOP_WORDS[row.stop_reason ?? ""] ?? "Chasing ended",
      code: "STOPPED",
      state: "skipped",
      at: null,
    });
  }

  return steps;
}

/** How far along the case is, for the little progress readout. */
export function journeyProgress(steps: JourneyStep[]): { done: number; total: number } {
  return {
    done: steps.filter((s) => s.state === "done").length,
    total: steps.length,
  };
}
