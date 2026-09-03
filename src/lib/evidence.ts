/**
 * Did it work, and did it behave.
 *
 * The board says what happened. This says whether any of it can be trusted -
 * the two questions a merchant asks before letting an agent talk to their
 * customers, and the two Track 03 asks to be answered together rather than
 * separately, because recovery that broke a rule is not recovery.
 *
 * Every figure is computed in Postgres from the rows themselves. Nothing here
 * reads a counter the worker kept about its own behaviour: a worker reporting
 * a clean week is precisely what a bug in the worker would also produce. This
 * is the same reasoning the batch harness is built on, available to a merchant
 * rather than only to whoever runs the script.
 */
import { db } from "./supabase";
import { profileFor } from "./classify";
import type { RootCause } from "./types";

/* ── did it work ─────────────────────────────────────────────────────────── */

export interface Arm {
  events: number;
  recovered: number;
  amount_at_risk: number;
  amount_recovered: number;
  /** Share of this arm's events that came back, 0-100. */
  rate: number;
}

export interface Lift {
  contacted: Arm;
  control: Arm | null;
  /** Percentage points between the arms. Null without a control to compare to. */
  points: number | null;
  /**
   * Whether the control arm is large enough to mean anything.
   *
   * Reported rather than silently applied. A lift computed over four events is
   * not evidence, and a page that shows the number without saying so is worse
   * than one that shows nothing - it invites a merchant to repeat a figure
   * they cannot defend. Thirty is not a significance test; it is the point
   * below which quoting the number is plainly unwise.
   */
  significant: boolean;
}

export const MIN_CONTROL_EVENTS = 30;

const EMPTY_ARM: Arm = {
  events: 0, recovered: 0, amount_at_risk: 0, amount_recovered: 0, rate: 0,
};

/** Share of an arm that recovered, as a percentage. Zero events is zero. */
export function recoveryRate(events: number, recovered: number): number {
  if (events <= 0) return 0;
  return Math.round((recovered / events) * 1000) / 10;
}

export function buildLift(rows: Array<Record<string, unknown>>): Lift {
  const arm = (name: string): Arm | null => {
    const r = rows.find((x) => x.arm === name);
    if (!r) return null;
    const events = Number(r.events ?? 0);
    const recovered = Number(r.recovered ?? 0);
    return {
      events,
      recovered,
      amount_at_risk: Number(r.amount_at_risk ?? 0),
      amount_recovered: Number(r.amount_recovered ?? 0),
      rate: recoveryRate(events, recovered),
    };
  };

  const contacted = arm("contacted") ?? EMPTY_ARM;
  const control = arm("control");

  return {
    contacted,
    control,
    // Rounded to one place to match the rates it is drawn from; without it,
    // 17.6 minus 0 arrives as 17.599999999999998.
    points: control ? Math.round((contacted.rate - control.rate) * 10) / 10 : null,
    significant: control !== null && control.events >= MIN_CONTROL_EVENTS,
  };
}

export async function merchantLift(merchantId: string, since: string): Promise<Lift> {
  const { data, error } = await db().rpc("merchant_arms", {
    p_merchant_id: merchantId,
    p_since: since,
  });
  if (error) throw new Error(`Could not load the arms: ${error.message}`);
  return buildLift((data ?? []) as Array<Record<string, unknown>>);
}

/* ── what it cost ────────────────────────────────────────────────────────── */

export interface Spend {
  byChannel: Array<{ channel: string; sent: number; cost_paise: number }>;
  total_paise: number;
}

export async function merchantSpend(merchantId: string, since: string): Promise<Spend> {
  const { data, error } = await db().rpc("merchant_spend", {
    p_merchant_id: merchantId,
    p_since: since,
  });
  if (error) throw new Error(`Could not load spend: ${error.message}`);
  const byChannel = ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    channel: String(r.channel),
    sent: Number(r.sent ?? 0),
    cost_paise: Number(r.cost_paise ?? 0),
  }));
  return {
    byChannel,
    total_paise: byChannel.reduce((sum, c) => sum + c.cost_paise, 0),
  };
}

/**
 * Rupees recovered per rupee spent chasing.
 *
 * Null rather than Infinity when nothing was spent: "recovered ₹7,697 for
 * nothing" is a true statement and not a ratio, and rendering it as one
 * produces the number ∞ on a page a merchant is meant to take seriously.
 */
export function returnOnSpend(recovered: number, spent: number): number | null {
  if (spent <= 0) return null;
  return Math.round(recovered / spent);
}

/* ── which failures are worth chasing ────────────────────────────────────── */

export interface CausePerformance {
  reason: RootCause;
  label: string;
  events: number;
  recovered: number;
  rate: number;
  amount_at_risk: number;
}

/**
 * Recovery rate per root cause, ordered by what is actually at stake.
 *
 * The most actionable table on the page: a merchant who can see that gateway
 * timeouts come back at sixty percent and expired cards at four has learnt
 * something they can do something about on Monday - chase the first harder,
 * and fix the dunning email for the second rather than sending it again.
 */
export async function merchantCauses(
  merchantId: string,
  since: string,
): Promise<CausePerformance[]> {
  const { data, error } = await db().rpc("merchant_failure_reasons", {
    p_merchant_id: merchantId,
    p_since: since,
  });
  if (error) throw new Error(`Could not load causes: ${error.message}`);

  return ((data ?? []) as Array<Record<string, unknown>>)
    .map((r) => {
      const reason = String(r.reason) as RootCause;
      const events = Number(r.event_count ?? 0);
      const recovered = Number(r.recovered_count ?? 0);
      return {
        reason,
        label: profileFor(reason).label,
        events,
        recovered,
        rate: recoveryRate(events, recovered),
        amount_at_risk: Number(r.amount_total ?? 0),
      };
    })
    .sort((a, b) => b.amount_at_risk - a.amount_at_risk);
}

/* ── did it behave ───────────────────────────────────────────────────────── */

export interface Invariant {
  id: string;
  /** What is being promised, in the merchant's terms rather than the code's. */
  claim: string;
  /** What a breach would mean, shown when there is one. */
  breach: string;
  breaches: number;
  held: boolean;
}

/**
 * The rules, in the order a merchant cares about them being broken.
 *
 * Contacting someone who asked to be left alone is first because it is the one
 * with a regulator attached. Tenant isolation is last not because it matters
 * least but because a breach there is a different kind of emergency, and
 * burying the everyday checks under it would make this list decorative.
 */
const INVARIANTS: Array<Pick<Invariant, "id" | "claim" | "breach">> = [
  {
    id: "opt_out_respected",
    claim: "Nobody was contacted after asking us to stop",
    breach: "message(s) went out after the customer had opted out",
  },
  {
    id: "contact_window",
    claim: "Nothing was sent outside your contact window",
    breach: "message(s) landed outside the hours you set",
  },
  {
    id: "attempt_cap",
    claim: "No case was chased past your attempt limit",
    breach: "case(s) went over the cap",
  },
  {
    id: "risk_escalated",
    claim: "Fraud-flagged payments went to a person, not a message",
    breach: "risk-flagged case(s) were messaged automatically",
  },
  {
    id: "no_doomed_retry",
    claim: "No card was retried when retrying could not work",
    breach: "retry(s) were scheduled for a cause that cannot succeed",
  },
  {
    id: "audit_complete",
    claim: "Every case acted on has a trail explaining why",
    breach: "case(s) changed state with nothing recorded",
  },
  {
    id: "reason_recorded",
    claim: "Every action records the reasoning behind it",
    breach: "action(s) have no rationale",
  },
  {
    id: "control_untouched",
    claim: "The held-back control group was never contacted",
    breach: "held-back customer(s) were messaged, which invalidates the comparison",
  },
  {
    id: "tenant_isolated",
    claim: "No action was filed against another business",
    breach: "action(s) crossed a tenant boundary",
  },
];

export function buildInvariants(rows: Array<Record<string, unknown>>): Invariant[] {
  const counts = new Map(
    rows.map((r) => [String(r.rule), Number(r.breaches ?? 0)]),
  );
  return INVARIANTS.map((i) => {
    // A rule the database did not report on is not a rule that passed. Absent
    // is absent, and showing it green would be the one lie this page cannot
    // afford - so it reads as a breach until something says otherwise.
    const breaches = counts.has(i.id) ? (counts.get(i.id) as number) : -1;
    return { ...i, breaches: Math.max(breaches, 0), held: breaches === 0 };
  });
}

export async function merchantInvariants(
  merchantId: string,
  since: string,
): Promise<Invariant[]> {
  const { data, error } = await db().rpc("merchant_invariants", {
    p_merchant_id: merchantId,
    p_since: since,
  });
  if (error) throw new Error(`Could not check the rules: ${error.message}`);
  return buildInvariants((data ?? []) as Array<Record<string, unknown>>);
}

/* ── when messages actually went ─────────────────────────────────────────── */

export interface SendHour {
  hour: number;
  sends: number;
  /** Whether this hour is inside the merchant's contact window. */
  inWindow: boolean;
}

/**
 * Does this local hour overlap the window at all?
 *
 * For shading the chart, and only that. An hour is a bucket an hour wide, so
 * it can straddle the edge of the window - 19:00-19:59 against a window that
 * closes at 19:00 is partly in and mostly out, and no colour can say that. The
 * verdict on whether anything actually breached comes from the invariant,
 * which compares each send's own timestamp and has no such ambiguity.
 *
 * Getting this backwards is how the page came to contradict itself: the rules
 * list said the window held while the chart under it announced four
 * violations, because an exclusive end excluded 23:00-23:59 from a window
 * running to 23:59. On a page whose entire claim is that it can be trusted,
 * two disagreeing answers are worse than either one being wrong alone.
 *
 * A window that wraps past midnight (22:00-06:00) is one window, not two - the
 * case a naive `start <= h && h <= end` silently paints as all violations.
 */
export function hourInWindow(hour: number, start: string, end: string): boolean {
  const h0 = Number(start.slice(0, 2));
  const h1 = Number(end.slice(0, 2));
  return h0 <= h1 ? hour >= h0 && hour <= h1 : hour >= h0 || hour <= h1;
}

export async function merchantSendHours(
  merchantId: string,
  since: string,
  window: { start: string; end: string },
): Promise<SendHour[]> {
  const { data, error } = await db().rpc("merchant_send_hours", {
    p_merchant_id: merchantId,
    p_since: since,
  });
  if (error) throw new Error(`Could not load send hours: ${error.message}`);

  const counts = new Map(
    ((data ?? []) as Array<Record<string, unknown>>).map((r) => [
      Number(r.hour), Number(r.sends ?? 0),
    ]),
  );
  // All twenty-four, always. The empty hours are the point of the chart - a
  // bar chart of only the hours we sent in cannot show that we never sent at
  // three in the morning, which is the thing being demonstrated.
  return Array.from({ length: 24 }, (_, hour) => ({
    hour,
    sends: counts.get(hour) ?? 0,
    inWindow: hourInWindow(hour, window.start, window.end),
  }));
}
