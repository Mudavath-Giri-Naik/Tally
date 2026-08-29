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
  recovery_rate: 0,
};

function sinceIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export async function merchantStats(
  merchantId: string,
  days = 30,
): Promise<MerchantStats> {
  const { data, error } = await db().rpc("merchant_stats", {
    p_merchant_id: merchantId,
    p_since: sinceIso(days),
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

export async function auditTrail(
  merchantId: string,
  limit = 50,
): Promise<AuditRow[]> {
  const { data, error } = await db()
    .from("actions")
    .select(
      "id, created_at, channel, outcome, message, decision, event_id, " +
        "events(type, amount, customers(name))",
    )
    .eq("merchant_id", merchantId)
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
