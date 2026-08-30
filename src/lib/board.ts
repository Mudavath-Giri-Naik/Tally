/**
 * The recovery board: what the dashboard's main view is made of.
 *
 * The six statuses are derived in SQL (see merchant_board in schema.sql), not
 * here, because the table, the tab counts and the metric cards all have to
 * agree about what "needs a human" means - and three copies of that rule is
 * three chances for them to drift apart.
 */
import { db } from "./supabase";
import { profileFor } from "./classify";
import type { RootCause } from "./types";

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

/** Label and dot colour token for each status. Order is the tab order. */
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
}

export interface BoardMetrics {
  total_events: number;
  recovered_count: number;
  amount_total: number;
  amount_recovered: number;
  recovery_rate: number;
  /** Null when nothing has been recovered yet - shown as "-", never as zero. */
  avg_recovery_seconds: number | null;
  sent_total: number;
  sent_in_window: number;
  needs_human: number;
  top_causes: Array<{ reason: RootCause; label: string; count: number }>;
}

export interface Board {
  rows: BoardRow[];
  metrics: BoardMetrics;
}

export async function boardRows(
  merchantId: string,
  days = 90,
): Promise<BoardRow[]> {
  const { data, error } = await db().rpc("merchant_board", {
    p_merchant_id: merchantId,
    p_since: sinceIso(days),
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
    };
  });
}

export async function boardMetrics(
  merchantId: string,
  days = 90,
): Promise<BoardMetrics> {
  const { data, error } = await db().rpc("merchant_board_metrics", {
    p_merchant_id: merchantId,
    p_since: sinceIso(days),
  });
  if (error) throw new Error(`Could not load the metrics: ${error.message}`);

  const raw = (data ?? {}) as Record<string, unknown>;
  const causes = (raw.top_causes ?? []) as Array<Record<string, unknown>>;

  return {
    total_events: Number(raw.total_events ?? 0),
    recovered_count: Number(raw.recovered_count ?? 0),
    amount_total: Number(raw.amount_total ?? 0),
    amount_recovered: Number(raw.amount_recovered ?? 0),
    recovery_rate: Number(raw.recovery_rate ?? 0),
    avg_recovery_seconds:
      raw.avg_recovery_seconds === null || raw.avg_recovery_seconds === undefined
        ? null
        : Number(raw.avg_recovery_seconds),
    sent_total: Number(raw.sent_total ?? 0),
    sent_in_window: Number(raw.sent_in_window ?? 0),
    needs_human: Number(raw.needs_human ?? 0),
    top_causes: causes.map((c) => {
      const reason = String(c.reason ?? "unknown") as RootCause;
      return {
        reason,
        label: profileFor(reason).label,
        count: Number(c.count ?? 0),
      };
    }),
  };
}

export async function loadBoard(merchantId: string, days = 90): Promise<Board> {
  const [rows, metrics] = await Promise.all([
    boardRows(merchantId, days),
    boardMetrics(merchantId, days),
  ]);
  return { rows, metrics };
}

/** One entry in an event's timeline. */
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
    in_window: r.in_window === null || r.in_window === undefined ? null : Boolean(r.in_window),
  }));
}

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

function sinceIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}
