/**
 * The dashboard's data layer.
 *
 * Everything on the page comes from here, for one merchant and one date range.
 * The statuses are derived in SQL (see merchant_board in schema.sql), not in
 * the UI, because the table, the tab counts, the status cards and the metric
 * cards all have to agree about what "needs a human" means - and four copies of
 * that rule is four chances for them to drift apart.
 */
import { db } from "./supabase";
import { profileFor } from "./classify";
import { workflowFor, DEFAULT_WORKFLOWS, normaliseWorkflows, type WorkflowId } from "./workflows";
import type { RootCause, Channel, EventType } from "./types";

export type BoardStatus =
  | "recovered"
  | "chasing"
  | "escalated_voice"
  | "needs_human"
  | "stopped"
  | "opted_out"
  // [+] admin overrides: "Flag as disputed" and "Write off" each need their
  // own status rather than folding into "stopped" - a merchant filtering the
  // table for stopped cases should not have to also mean disputed ones, and
  // written-off cases are excluded from the recovery rate specifically
  // because they are not "stopped", they are a business decision.
  | "disputed"
  | "written_off";

/**
 * Display order for the status tabs, and the only place it is defined.
 *
 * Roughly the arc a case travels: recovered first, then still-moving, then
 * handed off, then the several ways it can end. The two admin-only endings
 * come last because they are the rarest.
 */
export const BOARD_STATUSES: BoardStatus[] = [
  "recovered",
  "chasing",
  "escalated_voice",
  "needs_human",
  "stopped",
  "opted_out",
  "disputed",
  "written_off",
];

export const STATUS_META: Record<
  BoardStatus,
  { label: string; token: string; icon: string }
> = {
  recovered: { label: "Recovered", token: "recovered", icon: "●" },
  chasing: { label: "Chasing", token: "chasing", icon: "●" },
  escalated_voice: { label: "Escalated · voice", token: "voice", icon: "●" },
  needs_human: { label: "Needs human", token: "human", icon: "●" },
  stopped: { label: "Stopped", token: "stopped", icon: "●" },
  // A different mark, not just a different colour: opted out and stopped are
  // both grey, and colour alone would make them indistinguishable.
  opted_out: { label: "Opted out", token: "stopped", icon: "⊘" },
  disputed: { label: "Disputed", token: "disputed", icon: "◆" },
  written_off: { label: "Written off", token: "written_off", icon: "▬" },
};

/** The windows the picker offers, in days. */
export const RANGES = [7, 30, 90] as const;
export type RangeDays = (typeof RANGES)[number];

export function rangeDays(raw: string | undefined): RangeDays {
  const n = Number(raw);
  return (RANGES as readonly number[]).includes(n) ? (n as RangeDays) : 7;
}

export interface BoardRow {
  event_id: string;
  customer_id: string | null;
  customer_name: string | null;
  amount: number | null;
  reason: RootCause;
  reason_label: string;
  /**
   * What this cause actually calls for, in plain words - the same text the
   * agent is given as context. Derived here rather than fetched: it is a
   * property of the cause, so the row already carries everything needed and
   * the panel can say what the next step is aiming at without a round trip.
   */
  reason_remedy: string;
  /** Whether retrying this payment method could ever work. */
  reason_retryable: boolean;
  status: BoardStatus;
  attempts: number;
  max_attempts: number;
  failed_on: string;
  recovered_at: string | null;
  /** The last channel that actually landed, or null if nothing has yet. */
  last_channel: Channel | null;
  /** The event's own type - payment_failed, cart_abandoned, and so on. */
  event_type: string;
  /**
   * Which of the four workflows classified and handled this case. Null for
   * the events no workflow governs - see workflowFor.
   */
  workflow: WorkflowId | null;
  /** True while an admin's "Pause outreach" is in effect. */
  paused: boolean;
  /** Set by "Snooze until a date" - no automated contact fires before this. */
  hold_until: string | null;
  /** When the next automated step is due, if one is scheduled at all. */
  next_attempt_at: string | null;
  /**
   * Why the agent stopped, for the statuses that are a dead end. "Needs
   * human" covers a fraud flag, three failed cycles and an admin escalation
   * alike, and those want different responses from the merchant.
   */
  stop_reason: string | null;
}


export interface BoardMetrics {
  total_events: number;
  recovered_count: number;
  amount_total: number;
  amount_recovered: number;
  amount_at_risk: number;
  recovery_rate: number;
  avg_recovery_seconds: number | null;
  sent_total: number;
  sent_in_window: number;
  needs_human: number;
  escalated_voice: number;
  stopped: number;
  promise_active: number;
  top_causes: Array<{ reason: RootCause; label: string; count: number }>;
}

export interface DayPoint {
  day: string;
  events: number;
  recovered: number;
  amount_recovered: number;
  amount_at_risk: number;
  sent: number;
  sent_in_window: number;
}

export interface ChannelRecovery {
  channel: Channel;
  sent: number;
  reached: number;
  recovered: number;
  /** Of the events reached on this channel, how many came good. */
  rate: number;
}

export interface TodayStats {
  interventions_today: number;
  events_today: number;
  recovered_today: number;
  /** Of today's events, the share recovered. Null when nothing arrived. */
  recovery_rate_today: number | null;
}

export interface Dashboard {
  days: RangeDays;
  from: string;
  to: string;
  rows: BoardRow[];
  metrics: BoardMetrics;
  /** The same figures for the equal-length window immediately before. */
  previous: BoardMetrics;
  series: DayPoint[];
  channels: ChannelRecovery[];
  today: TodayStats;
  /** Which recovery workflows this merchant currently runs. */
  workflows_enabled: WorkflowId[];
}

/* ── loaders ─────────────────────────────────────────────────────────────── */

function mapBoardRow(r: Record<string, unknown>): BoardRow {
  const reason = String(r.reason ?? "unknown") as RootCause;
  const eventType = String(r.event_type ?? "unknown");
  return {
    // Derived here rather than in SQL so the mapping lives in exactly one
    // place - the same function the worker's gate consults before acting.
    workflow: workflowFor(eventType as EventType, reason),
    event_id: String(r.event_id),
    customer_id: (r.customer_id as string) ?? null,
    customer_name: (r.customer_name as string) ?? null,
    amount: r.amount === null ? null : Number(r.amount),
    reason,
    reason_label: profileFor(reason).label,
    reason_remedy: profileFor(reason).remedy,
    reason_retryable: profileFor(reason).retryable,
    status: String(r.status) as BoardStatus,
    attempts: Number(r.attempts ?? 0),
    max_attempts: Number(r.max_attempts ?? 3),
    failed_on: String(r.failed_on),
    recovered_at: (r.recovered_at as string) ?? null,
    last_channel: (r.last_channel as Channel) ?? null,
    event_type: eventType,
    paused: Boolean(r.paused ?? false),
    hold_until: (r.hold_until as string) ?? null,
    next_attempt_at: (r.next_attempt_at as string) ?? null,
    stop_reason: (r.stop_reason as string) ?? null,
  };
}

export async function boardRows(
  merchantId: string,
  since: string,
  until: string | null = null,
): Promise<BoardRow[]> {
  const { data, error } = await db().rpc("merchant_board", {
    p_merchant_id: merchantId,
    p_since: since,
    p_until: until,
  });
  if (error) throw new Error(`Could not load the board: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map(mapBoardRow);
}

/**
 * One row, by event id, regardless of when it happened.
 *
 * Used to re-derive a case's current status before and after an admin
 * override - the same SQL the board itself uses, so validating an action
 * against "what status is this actually in" can never drift from what the
 * table is showing.
 */
export async function boardRowForEvent(
  merchantId: string,
  eventId: string,
): Promise<BoardRow | null> {
  const { data, error } = await db().rpc("merchant_board", {
    p_merchant_id: merchantId,
    p_event_id: eventId,
  });
  if (error) throw new Error(`Could not load that case: ${error.message}`);
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  return rows.length > 0 ? mapBoardRow(rows[0]) : null;
}

export async function boardMetrics(
  merchantId: string,
  since: string,
  until: string | null = null,
): Promise<BoardMetrics> {
  const { data, error } = await db().rpc("merchant_board_metrics", {
    p_merchant_id: merchantId,
    p_since: since,
    p_until: until,
  });
  if (error) throw new Error(`Could not load the metrics: ${error.message}`);

  const raw = (data ?? {}) as Record<string, unknown>;
  const causes = (raw.top_causes ?? []) as Array<Record<string, unknown>>;
  const n = (k: string) => Number(raw[k] ?? 0);

  return {
    total_events: n("total_events"),
    recovered_count: n("recovered_count"),
    amount_total: n("amount_total"),
    amount_recovered: n("amount_recovered"),
    amount_at_risk: n("amount_at_risk"),
    recovery_rate: n("recovery_rate"),
    avg_recovery_seconds:
      raw.avg_recovery_seconds === null || raw.avg_recovery_seconds === undefined
        ? null
        : Number(raw.avg_recovery_seconds),
    sent_total: n("sent_total"),
    sent_in_window: n("sent_in_window"),
    needs_human: n("needs_human"),
    escalated_voice: n("escalated_voice"),
    stopped: n("stopped"),
    promise_active: n("promise_active"),
    top_causes: causes.map((c) => {
      const reason = String(c.reason ?? "unknown") as RootCause;
      return { reason, label: profileFor(reason).label, count: Number(c.count ?? 0) };
    }),
  };
}

export async function boardSeries(
  merchantId: string,
  since: string,
  until: string | null = null,
): Promise<DayPoint[]> {
  const { data, error } = await db().rpc("merchant_board_series", {
    p_merchant_id: merchantId,
    p_since: since,
    p_until: until,
  });
  if (error) throw new Error(`Could not load the timeline: ${error.message}`);

  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    day: String(r.day),
    events: Number(r.events ?? 0),
    recovered: Number(r.recovered ?? 0),
    amount_recovered: Number(r.amount_recovered ?? 0),
    amount_at_risk: Number(r.amount_at_risk ?? 0),
    sent: Number(r.sent ?? 0),
    sent_in_window: Number(r.sent_in_window ?? 0),
  }));
}

export async function channelRecovery(
  merchantId: string,
  since: string,
  until: string | null = null,
): Promise<ChannelRecovery[]> {
  const { data, error } = await db().rpc("merchant_channel_recovery", {
    p_merchant_id: merchantId,
    p_since: since,
    p_until: until,
  });
  if (error) throw new Error(`Could not load channel recovery: ${error.message}`);

  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => {
    const reached = Number(r.reached ?? 0);
    const recovered = Number(r.recovered ?? 0);
    return {
      channel: String(r.channel) as Channel,
      sent: Number(r.sent ?? 0),
      reached,
      recovered,
      // Of the events reached on this channel, how many came good. Zero
      // reached is a rate of zero, not a division by zero.
      rate: reached === 0 ? 0 : Math.round((recovered / reached) * 100),
    };
  });
}

/**
 * Just the merchant's enabled workflows.
 *
 * A narrow select rather than `getMerchant`, deliberately: this module is
 * imported by the dashboard's client component for its types and constants,
 * and pulling in the merchants module would drag credential decryption into
 * that import graph for the sake of one text[] column.
 */
export async function enabledWorkflows(merchantId: string): Promise<WorkflowId[]> {
  const { data, error } = await db()
    .from("merchants")
    .select("workflows_enabled")
    .eq("id", merchantId)
    .maybeSingle();
  if (error) throw new Error(`Could not load the workflows: ${error.message}`);

  const stored = normaliseWorkflows((data as { workflows_enabled?: unknown } | null)?.workflows_enabled);
  // A row written before the column existed reads back empty; all four is
  // what that merchant was effectively running.
  return stored.length > 0 ? stored : DEFAULT_WORKFLOWS;
}

export async function todayStats(merchantId: string): Promise<TodayStats> {
  const { data, error } = await db().rpc("merchant_today", {
    p_merchant_id: merchantId,
  });
  if (error) throw new Error(`Could not load today: ${error.message}`);

  const raw = (data ?? {}) as Record<string, unknown>;
  const events = Number(raw.events_today ?? 0);
  const recovered = Number(raw.recovered_today ?? 0);
  return {
    interventions_today: Number(raw.interventions_today ?? 0),
    events_today: events,
    recovered_today: recovered,
    // Null rather than 0% when nothing arrived today: no events is not a
    // failure to recover them.
    recovery_rate_today: events === 0 ? null : Math.round((recovered / events) * 100),
  };
}

/**
 * The whole page, for one window.
 *
 * The previous window is the same length ending where this one begins, so
 * "vs previous period" compares like with like whatever the picker says.
 */
export async function loadDashboard(
  merchantId: string,
  days: RangeDays = 7,
): Promise<Dashboard> {
  const now = Date.now();
  const from = new Date(now - days * 86_400_000).toISOString();
  const prevFrom = new Date(now - 2 * days * 86_400_000).toISOString();

  const [rows, metrics, previous, series, channels, today, workflows] =
    await Promise.all([
      boardRows(merchantId, from),
      boardMetrics(merchantId, from),
      boardMetrics(merchantId, prevFrom, from),
      boardSeries(merchantId, from),
      channelRecovery(merchantId, from),
      todayStats(merchantId),
      enabledWorkflows(merchantId),
    ]);

  return {
    days,
    from,
    to: new Date(now).toISOString(),
    rows,
    metrics,
    previous,
    series,
    channels,
    today,
    workflows_enabled: workflows,
  };
}

/**
 * Marks who said what inside a WhatsApp action row, which otherwise holds
 * outbound copy, inbound replies and the agent's own summaries in one column.
 *
 * Defined here rather than in the conversational agent so the dashboard (a
 * client component) can read them back without pulling in the agent's model
 * providers - the agent re-exports these rather than redefining them.
 */
export const INBOUND_PREFIX = "[inbound] ";
export const REPLY_PREFIX = "[reply] ";
export const SUMMARY_PREFIX = "[conversation] ";

/* ── the timeline behind one row ─────────────────────────────────────────── */

export interface TimelineEntry {
  id: string;
  created_at: string;
  sent_at: string | null;
  channel: string | null;
  outcome: string;
  message: string | null;
  intervention: string | null;
  rationale: string | null;
  guardrail: string | null;
  /** Null for anything never sent - neither compliant nor non-compliant. */
  in_window: boolean | null;
  /** Which admin override this was, if a merchant made this happen by hand. */
  admin_action: string | null;
  /**
   * "agent" when the model's choice stood, "guardrail" when a rule changed
   * or overrode it. The audit trail's whole purpose is showing both.
   */
  source: string | null;
  /** The provider's reply - its id on a success, its error text on a failure. */
  response: string | null;
}

export async function eventTimeline(
  merchantId: string,
  eventId: string,
): Promise<TimelineEntry[]> {
  const { data, error } = await db().rpc("event_timeline", {
    p_merchant_id: merchantId,
    p_event_id: eventId,
  });
  if (error) throw new Error(`Could not load the timeline: ${error.message}`);

  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    created_at: String(r.created_at),
    sent_at: (r.sent_at as string) ?? null,
    channel: (r.channel as string) ?? null,
    outcome: String(r.outcome),
    message: (r.message as string) ?? null,
    intervention: (r.intervention as string) ?? null,
    rationale: (r.rationale as string) ?? null,
    guardrail: (r.guardrail as string) ?? null,
    in_window:
      r.in_window === null || r.in_window === undefined ? null : Boolean(r.in_window),
    admin_action: (r.admin_action as string) ?? null,
    source: (r.source as string) ?? null,
    response: (r.response as string) ?? null,
  }));
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

/** "4m 7s", "2h 15m", "3d" - short enough for a metric card. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem ? `${m}m ${rem}s` : `${m}m`;
  }
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(s / 86400);
  const h = Math.round((s % 86400) / 3600);
  return h ? `${d}d ${h}h` : `${d}d`;
}

/**
 * Percentage change against the previous window.
 *
 * Null when the previous window had nothing to compare against: growth from
 * zero is not a percentage, and "+100%" for a first recovery would be a lie
 * dressed as a metric.
 */
export function delta(now: number, before: number): number | null {
  if (before === 0) return null;
  return Math.round(((now - before) / before) * 1000) / 10;
}
