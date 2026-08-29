/**
 * Dashboard numbers. All aggregation happens in Postgres (see schema.sql);
 * this module just calls it and gives the results a shape the UI can render.
 */
import { db } from "./supabase";
import { profileFor } from "./classify";
import type { RootCause, Channel } from "./types";

export interface MerchantStats {
  total_events: number;
  recovered: number;
  open: number;
  stopped: number;
  unrecoverable: number;
  amount_at_risk: number;
  amount_recovered: number;
  amount_unrecoverable: number;
  recovery_rate: number;
}

export interface FailureReason {
  reason: RootCause;
  label: string;
  remedy: string;
  event_count: number;
  amount_total: number;
  recovered_count: number;
}

export interface ChannelPerformance {
  channel: Channel;
  sent: number;
  failed: number;
  recovered: number;
}

const EMPTY_STATS: MerchantStats = {
  total_events: 0,
  recovered: 0,
  open: 0,
  stopped: 0,
  unrecoverable: 0,
  amount_at_risk: 0,
  amount_recovered: 0,
  amount_unrecoverable: 0,
  recovery_rate: 0,
};

function sinceIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export async function merchantStats(
  merchantId: string,
  days = 30,
  /** Days back from now the window *ends*. 0 means "up to now". */
  offsetDays = 0,
): Promise<MerchantStats> {
  const { data, error } = await db().rpc("merchant_stats", {
    p_merchant_id: merchantId,
    p_since: sinceIso(days + offsetDays),
    p_until: sinceIso(offsetDays),
  });
  if (error) throw new Error(`Could not load stats: ${error.message}`);
  if (!data) return EMPTY_STATS;

  const raw = data as Record<string, unknown>;
  return {
    total_events: Number(raw.total_events ?? 0),
    recovered: Number(raw.recovered ?? 0),
    open: Number(raw.open ?? 0),
    stopped: Number(raw.stopped ?? 0),
    unrecoverable: Number(raw.unrecoverable ?? 0),
    amount_at_risk: Number(raw.amount_at_risk ?? 0),
    amount_recovered: Number(raw.amount_recovered ?? 0),
    amount_unrecoverable: Number(raw.amount_unrecoverable ?? 0),
    recovery_rate: Number(raw.recovery_rate ?? 0),
  };
}

/**
 * "Most common failure reasons this week", with the remedy attached - the
 * number on its own is trivia; the number plus what fixes it is the insight.
 */
export async function failureReasons(
  merchantId: string,
  days = 7,
): Promise<FailureReason[]> {
  const { data, error } = await db().rpc("merchant_failure_reasons", {
    p_merchant_id: merchantId,
    p_since: sinceIso(days),
  });
  if (error) throw new Error(`Could not load failure reasons: ${error.message}`);

  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => {
    const reason = String(r.reason ?? "unknown") as RootCause;
    const profile = profileFor(reason);
    return {
      reason,
      label: profile.label,
      remedy: profile.remedy,
      event_count: Number(r.event_count ?? 0),
      amount_total: Number(r.amount_total ?? 0),
      recovered_count: Number(r.recovered_count ?? 0),
    };
  });
}

export async function channelPerformance(
  merchantId: string,
  days = 30,
): Promise<ChannelPerformance[]> {
  const { data, error } = await db().rpc("merchant_channel_performance", {
    p_merchant_id: merchantId,
    p_since: sinceIso(days),
  });
  if (error) throw new Error(`Could not load channel stats: ${error.message}`);

  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    channel: String(r.channel) as Channel,
    sent: Number(r.sent ?? 0),
    failed: Number(r.failed ?? 0),
    recovered: Number(r.recovered ?? 0),
  }));
}

/** The live audit trail: what the agent did, to whom, and why. */
export interface AuditRow {
  id: string;
  created_at: string;
  channel: Channel | null;
  outcome: string;
  message: string | null;
  rationale: string | null;
  guardrail: string | null;
  intervention: string | null;
  root_cause: string | null;
  event_id: string;
  event_type: string;
  amount: number | null;
  customer_name: string | null;
}

export interface AuditFilter {
  outcome?: string;
  channel?: string;
}

export async function auditTrail(
  merchantId: string,
  limit = 50,
  filter: AuditFilter = {},
): Promise<AuditRow[]> {
  let q = db()
    .from("actions")
    .select(
      "id, created_at, channel, outcome, message, decision, event_id, " +
        "events(type, amount, customers(name))",
    )
    .eq("merchant_id", merchantId);

  if (filter.outcome) q = q.eq("outcome", filter.outcome);
  // "none" is the filter for decisions the agent made without sending
  // anything - the guardrail cases, which are the interesting ones.
  if (filter.channel === "none") q = q.is("channel", null);
  else if (filter.channel) q = q.eq("channel", filter.channel);

  const { data, error } = await q
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Could not load audit trail: ${error.message}`);

  return ((data ?? []) as Array<Record<string, any>>).map((r) => ({
    id: r.id,
    created_at: r.created_at,
    channel: r.channel,
    outcome: r.outcome,
    message: r.message,
    rationale: r.decision?.rationale ?? null,
    guardrail: r.decision?.guardrail ?? null,
    intervention: r.decision?.intervention ?? null,
    root_cause: r.decision?.root_cause ?? null,
    event_id: r.event_id,
    event_type: r.events?.type ?? "unknown",
    amount: r.events?.amount ?? null,
    customer_name: r.events?.customers?.name ?? null,
  }));
}

/**
 * The same numbers, next to the period immediately before them.
 *
 * A recovery figure on its own is not information - ₹40,000 recovered is
 * either very good or a collapse depending on last month. The delta is the
 * part a merchant actually reads.
 */
export interface StatsWithTrend extends MerchantStats {
  previous: MerchantStats;
  /** Percent change vs the previous window, or null when it had no base. */
  recovered_delta_pct: number | null;
  events_delta_pct: number | null;
  rate_delta_points: number | null;
}

function pctChange(now: number, before: number): number | null {
  // Growth from zero is not a percentage, it is a new thing happening. Saying
  // "+100%" for the first ever recovery would be a lie dressed as a metric.
  if (before === 0) return null;
  return Math.round(((now - before) / before) * 1000) / 10;
}

export async function statsWithTrend(
  merchantId: string,
  days = 30,
): Promise<StatsWithTrend> {
  const [current, previous] = await Promise.all([
    merchantStats(merchantId, days),
    merchantStats(merchantId, days, days),
  ]);

  return {
    ...current,
    previous,
    recovered_delta_pct: pctChange(
      current.amount_recovered,
      previous.amount_recovered,
    ),
    events_delta_pct: pctChange(current.total_events, previous.total_events),
    rate_delta_points:
      previous.total_events === 0
        ? null
        : Math.round((current.recovery_rate - previous.recovery_rate) * 10) / 10,
  };
}

/** One row per day, including the days nothing happened. */
export interface DailyPoint {
  day: string;
  events: number;
  recovered: number;
  amount_recovered: number;
  amount_at_risk: number;
}

export async function dailySeries(
  merchantId: string,
  days = 14,
): Promise<DailyPoint[]> {
  const { data, error } = await db().rpc("merchant_daily_series", {
    p_merchant_id: merchantId,
    p_days: days,
  });
  if (error) throw new Error(`Could not load the timeline: ${error.message}`);

  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    day: String(r.day),
    events: Number(r.events ?? 0),
    recovered: Number(r.recovered ?? 0),
    amount_recovered: Number(r.amount_recovered ?? 0),
    amount_at_risk: Number(r.amount_at_risk ?? 0),
  }));
}

/** A customer, with their whole history with this merchant folded in. */
export interface CustomerRow {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  opted_out: boolean;
  created_at: string;
  total_events: number;
  recovered: number;
  open_events: number;
  amount_recovered: number;
  amount_at_risk: number;
  last_event_at: string | null;
}

export async function customerRows(
  merchantId: string,
  limit = 100,
): Promise<CustomerRow[]> {
  const { data, error } = await db().rpc("merchant_customers", {
    p_merchant_id: merchantId,
    p_limit: limit,
  });
  if (error) throw new Error(`Could not load customers: ${error.message}`);

  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    name: (r.name as string) ?? null,
    email: (r.email as string) ?? null,
    phone: (r.phone as string) ?? null,
    opted_out: Boolean(r.opted_out),
    created_at: String(r.created_at),
    total_events: Number(r.total_events ?? 0),
    recovered: Number(r.recovered ?? 0),
    open_events: Number(r.open_events ?? 0),
    amount_recovered: Number(r.amount_recovered ?? 0),
    amount_at_risk: Number(r.amount_at_risk ?? 0),
    last_event_at: (r.last_event_at as string) ?? null,
  }));
}

/** How the agent's decisions broke down: sent, skipped, escalated, failed. */
export async function actionSummary(
  merchantId: string,
  days = 30,
): Promise<Record<string, number>> {
  const { data, error } = await db().rpc("merchant_action_summary", {
    p_merchant_id: merchantId,
    p_since: sinceIso(days),
  });
  if (error) throw new Error(`Could not load the action summary: ${error.message}`);

  const out: Record<string, number> = {};
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    out[String(r.outcome)] = Number(r.count ?? 0);
  }
  return out;
}
