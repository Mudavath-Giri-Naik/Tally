/**
 * The dashboard's data layer.
 *
 * Everything on the page comes from here, for one merchant and one date range.
 * The six statuses are derived in SQL (see merchant_board in schema.sql), not
 * in the UI, because the table, the tab counts, the status cards and the metric
 * cards all have to agree about what "needs a human" means - and four copies of
 * that rule is four chances for them to drift apart.
 */
import { db } from "./supabase";
import { profileFor } from "./classify";
import type { RootCause, Channel } from "./types";

export type BoardStatus =
  | "recovered"
  | "chasing"
  | "escalated_voice"
  | "needs_human"
  | "stopped"
  | "opted_out";

export const BOARD_STATUSES: BoardStatus[] = [
  "recovered",
  "chasing",
  "escalated_voice",
  "needs_human",
  "stopped",
  "opted_out",
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
  status: BoardStatus;
  attempts: number;
  max_attempts: number;
  failed_on: string;
  recovered_at: string | null;
  /** The last channel that actually landed, or null if nothing has yet. */
  last_channel: Channel | null;
  /** The event's own type - payment_failed, cart_abandoned, and so on. */
  event_type: string;
}

/**
 * How many distinct event types exist at all.
 *
 * Fixed by the `events_type_valid` check constraint in schema.sql, not
 * per-tenant data - every merchant shares the same six. "Active workflows"
 * counts how many of these six actually occurred in the window.
 */
export const WORKFLOW_TYPE_COUNT = 6;

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
}

/* ── loaders ─────────────────────────────────────────────────────────────── */

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

  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => {
    const reason = String(r.reason ?? "unknown") as RootCause;
    return {
      event_id: String(r.event_id),
      customer_id: (r.customer_id as string) ?? null,
      customer_name: (r.customer_name as string) ?? null,
      amount: r.amount === null ? null : Number(r.amount),
      reason,
      reason_label: profileFor(reason).label,
      status: String(r.status) as BoardStatus,
      attempts: Number(r.attempts ?? 0),
      max_attempts: Number(r.max_attempts ?? 3),
      failed_on: String(r.failed_on),
      recovered_at: (r.recovered_at as string) ?? null,
      last_channel: (r.last_channel as Channel) ?? null,
      event_type: String(r.event_type ?? "unknown"),
    };
  });
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

  const [rows, metrics, previous, series, channels, today] = await Promise.all([
    boardRows(merchantId, from),
    boardMetrics(merchantId, from),
    boardMetrics(merchantId, prevFrom, from),
    boardSeries(merchantId, from),
    channelRecovery(merchantId, from),
    todayStats(merchantId),
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
  };
}

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
