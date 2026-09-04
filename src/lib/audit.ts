/**
 * The Audit Trail: every row in `actions`, exactly as recorded, for one
 * merchant.
 *
 * This is the canonical place a merchant reads a guardrail or clamp reason -
 * the customer detail panel used to surface it inline per attempt, which
 * meant the same fact lived in two places that could read differently once
 * either one changed. Here it reads straight off the row, unfiltered by
 * per-channel presentation.
 *
 * Paginated with `range()` against the real table rather than a database
 * function: the filters are a plain equality and a small outcome bucket, both
 * of which PostgREST already expresses, and an embedded `events!inner(...)`
 * scopes and filters by customer in the same round trip - see
 * `listEventsFiltered` in events.ts for the identical pattern.
 */
import { db } from "./supabase";
import type { Channel, Merchant } from "./types";

export const ACTION_TYPES = ["sent", "blocked", "escalated", "inaction"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export function isActionType(v: unknown): v is ActionType {
  return typeof v === "string" && (ACTION_TYPES as readonly string[]).includes(v);
}

/** Which stored `outcome`s a filter bucket covers. */
const OUTCOME_BUCKET: Record<ActionType, string[]> = {
  // A failed send was still an attempt on that channel, not a guardrail
  // withholding it - it belongs beside the sends that worked.
  sent: ["sent", "delivered", "failed"],
  // A rule diverted or suppressed what the agent proposed - a deferred send,
  // a workflow switched off, a sibling event folded into another message.
  blocked: ["skipped"],
  escalated: ["escalated"],
  // A deliberate no-op: the case stopped, with nothing sent on any channel.
  inaction: ["no_action", "pending"],
};

export interface AuditRow {
  id: string;
  created_at: string;
  sent_at: string | null;
  event_id: string;
  customer_id: string | null;
  customer_name: string | null;
  channel: Channel | null;
  outcome: string;
  /** What the agent or a guardrail decided to do - `decision.intervention`. */
  intervention: string | null;
  /** Which guardrail fired, if this row was a rule's doing rather than the model's. */
  guardrail: string | null;
  rationale: string | null;
  /**
   * Whether this send falls inside the merchant's own contact window.
   * Null for anything never sent - a decision to wait is neither compliant
   * nor non-compliant.
   */
  in_window: boolean | null;
}

export interface AuditFilter {
  limit?: number;
  offset?: number;
  customerId?: string | null;
  type?: ActionType | null;
}

export interface AuditPage {
  rows: AuditRow[];
  total: number;
}

function toMinutes(hhmmss: string): number {
  const [h, m] = hhmmss.split(":");
  return Number(h) * 60 + Number(m ?? 0);
}

/**
 * Local wall-clock time-of-day, in the merchant's own timezone, as minutes
 * since midnight. Intl rather than a date library - the whole point of `at
 * time zone` in the SQL this mirrors is a timezone conversion, and
 * `Intl.DateTimeFormat` is the one timezone database Node already ships.
 */
function localMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return get("hour") * 60 + get("minute");
}

/**
 * Was `at` inside the merchant's contact window - inclusive of both ends, so
 * a send at exactly the opening or closing minute passes. Mirrors the SQL
 * `between m.contact_window_start and m.contact_window_end` used everywhere
 * else this window is judged (see `event_timeline`, `merchant_invariants`),
 * rather than the stricter exclusive-end check `withinContactWindow` in
 * rules.ts uses to decide whether to send *right now* - a different question
 * from "was this compliant", and not this function's to change.
 */
export function inContactWindow(
  at: Date,
  merchant: Pick<Merchant, "timezone" | "contact_window_start" | "contact_window_end">,
): boolean {
  const minutes = localMinutes(at, merchant.timezone);
  const start = toMinutes(merchant.contact_window_start);
  const end = toMinutes(merchant.contact_window_end);
  if (start <= end) return minutes >= start && minutes <= end;
  // A window that wraps past midnight (e.g. 22:00-06:00) is unusual but legal.
  return minutes >= start || minutes <= end;
}

interface RawAuditRow {
  id: string;
  event_id: string;
  created_at: string;
  sent_at: string | null;
  channel: Channel | null;
  outcome: string;
  decision: Record<string, unknown> | null;
  events: {
    customer_id: string | null;
    metadata: Record<string, unknown> | null;
    customers: { name: string | null } | null;
  } | null;
}

export async function listActions(
  merchant: Merchant,
  filter: AuditFilter = {},
): Promise<AuditPage> {
  const limit = Math.min(Math.max(filter.limit ?? 25, 1), 200);
  const offset = Math.max(filter.offset ?? 0, 0);

  let q = db()
    .from("actions")
    .select(
      "id, event_id, created_at, sent_at, channel, outcome, decision, events!inner(customer_id, metadata, customers(name))",
      { count: "exact" },
    )
    .eq("merchant_id", merchant.id);

  if (filter.customerId) q = q.eq("events.customer_id", filter.customerId);
  if (filter.type) q = q.in("outcome", OUTCOME_BUCKET[filter.type]);

  const { data, error, count } = await q
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw new Error(`Could not load the audit trail: ${error.message}`);

  const rows = ((data ?? []) as unknown as RawAuditRow[]).map((r) => {
    const decision = r.decision ?? null;
    const event = r.events;
    return {
      id: r.id,
      created_at: r.created_at,
      sent_at: r.sent_at,
      event_id: r.event_id,
      customer_id: event?.customer_id ?? null,
      customer_name:
        (event?.metadata?.customer_name as string | undefined) ??
        event?.customers?.name ??
        null,
      channel: r.channel,
      outcome: r.outcome,
      intervention: (decision?.intervention as string) ?? null,
      guardrail: (decision?.guardrail as string) ?? null,
      rationale: (decision?.rationale as string) ?? null,
      in_window:
        r.sent_at === null || r.channel === null
          ? null
          : inContactWindow(new Date(r.sent_at), merchant),
    };
  });

  return { rows, total: count ?? rows.length };
}
