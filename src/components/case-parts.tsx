"use client";

/**
 * The small presentational pieces a case is rendered from.
 *
 * Extracted from the Overview when the table moved to its own page: the
 * status badge on a Customers row and the one in the detail panel header
 * have to look identical, and two copies of a colour map is how they stop
 * being identical. Nothing here holds state or fetches anything.
 */
import Image from "next/image";
import Link from "next/link";

import {
  ArchiveIcon,
  BanIcon,
  CalendarClockIcon,
  CircleCheckIcon,
  FastForwardIcon,
  FlagIcon,
  PauseIcon,
  PlayIcon,
  Undo2Icon,
  UserIcon,
} from "lucide-react";

import { STATUS_META, type BoardStatus, type BoardRow } from "@/lib/board";
import { WORKFLOWS, WORKFLOW_IDS, type WorkflowId } from "@/lib/workflows";
import type { AdminActionId } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

/* ── status → shadcn badge treatment ─────────────────────────────────────── */

export const STATUS_CLASS: Record<string, string> = {
  recovered:
    "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-400 dark:border-emerald-900",
  chasing:
    "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/50 dark:text-amber-400 dark:border-amber-900",
  voice:
    "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/50 dark:text-blue-400 dark:border-blue-900",
  human:
    "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/50 dark:text-red-400 dark:border-red-900",
  stopped: "bg-muted text-muted-foreground border-border",
  disputed:
    "bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/50 dark:text-purple-400 dark:border-purple-900",
  written_off:
    "bg-slate-100 text-slate-600 border-slate-300 dark:bg-slate-900/50 dark:text-slate-400 dark:border-slate-800",
};

export const DOT_CLASS: Record<string, string> = {
  recovered: "bg-emerald-500",
  chasing: "bg-amber-500",
  voice: "bg-blue-500",
  human: "bg-red-500",
  stopped: "bg-muted-foreground/60",
  disputed: "bg-purple-500",
  written_off: "bg-slate-400",
};

/** Text-only counterpart to STATUS_CLASS, for the dot+label treatment used
 * in the table's Status column rather than a full badge box. */
export const STATUS_TEXT_CLASS: Record<string, string> = {
  recovered: "text-emerald-700 dark:text-emerald-400",
  chasing: "text-amber-700 dark:text-amber-400",
  voice: "text-blue-700 dark:text-blue-400",
  human: "text-red-700 dark:text-red-400",
  stopped: "text-muted-foreground",
  disputed: "text-purple-700 dark:text-purple-400",
  written_off: "text-slate-600 dark:text-slate-400",
};

/* ── formatters ──────────────────────────────────────────────────────────── */

export function initials(name: string | null): string {
  if (!name?.trim()) return "?";
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");
}

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric", month: "short", year: "numeric",
  });
}

export function shortTime(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

/**
 * "just now", "12m ago", "3d ago" - how long since something happened.
 *
 * Paired with the exact time rather than replacing it: the relative form is
 * what makes a trail feel live, but "2h ago" alone cannot be reconciled
 * against a provider's own logs, so the absolute stamp stays alongside it.
 */
export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.round((now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  const days = Math.round(seconds / 86400);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

/** Rupees, abbreviated the Indian way, for an axis where space is scarce. */
export function compactINR(paise: number): string {
  const r = paise / 100;
  if (r >= 1e7) return `₹${(r / 1e7).toFixed(r % 1e7 === 0 ? 0 : 1)}Cr`;
  if (r >= 1e5) return `₹${(r / 1e5).toFixed(r % 1e5 === 0 ? 0 : 1)}L`;
  if (r >= 1e3) return `₹${(r / 1e3).toFixed(r % 1e3 === 0 ? 0 : 1)}K`;
  return `₹${Math.round(r)}`;
}

/* ── avatar colour ───────────────────────────────────────────────────────── */

const AVATAR_PALETTE = [
  "bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300",
  "bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300",
  "bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300",
  "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  "bg-teal-100 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300",
  "bg-indigo-100 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300",
];

/**
 * A stable tint per customer - hashed from an id that never changes, so the
 * same person keeps the same colour across a poll or a reload rather than
 * reshuffling every render the way `Math.random()` would.
 */
export function avatarTone(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

/* ── recovery chance ─────────────────────────────────────────────────────── */

/**
 * A quick-glance estimate of how likely a case still is to be paid, scored
 * from what the row already carries - not a stored or modelled figure, so it
 * can never disagree with the status sitting right next to it. Resolved
 * cases resolve to their obvious ends; anything still moving is marked down
 * for every attempt already spent and up for a cause that can actually
 * succeed on a retry.
 */
export function recoveryChance(row: BoardRow): number {
  if (row.status === "recovered") return 100;
  if (row.status === "written_off" || row.status === "opted_out") return 0;
  if (row.status === "stopped") return 10;
  if (row.status === "disputed") return 50;

  let score = row.reason_retryable ? 65 : 30;
  score -= row.attempts * 8;
  if (row.channels_used.length > 1) score += 8;
  if (row.status === "needs_human") score -= 15;
  if (row.status === "escalated_voice") score -= 5;
  return Math.max(8, Math.min(95, Math.round(score)));
}

function recoveryTone(value: number): { ring: string; text: string } {
  if (value >= 70) return { ring: "text-emerald-500", text: "text-emerald-700 dark:text-emerald-400" };
  if (value >= 40) return { ring: "text-amber-500", text: "text-amber-700 dark:text-amber-400" };
  return { ring: "text-red-500", text: "text-red-700 dark:text-red-400" };
}

export function RecoveryRing({ value, size = 34 }: { value: number; size?: number }) {
  const stroke = 3;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c - (value / 100) * c;
  const tone = recoveryTone(value);
  return (
    <div
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
      title={`${value}% chance of recovery`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-muted" />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke}
          strokeDasharray={c} strokeDashoffset={offset} strokeLinecap="round"
          stroke="currentColor" className={tone.ring}
        />
      </svg>
      <span className={cn("absolute text-[0.6rem] font-bold tabular-nums", tone.text)}>{value}%</span>
    </div>
  );
}

/* ── next action ─────────────────────────────────────────────────────────── */

const NEXT_ACTION_LABEL: Record<BoardStatus, string> = {
  recovered: "Completed",
  chasing: "Send reminder",
  escalated_voice: "Follow-up call",
  needs_human: "Agent review",
  stopped: "No action",
  opted_out: "Opted out",
  disputed: "Under review",
  written_off: "Written off",
};

/**
 * What happens next on this case, and when - read off the row rather than
 * kept as a separate field, so it can never say something the schedule
 * itself does not agree with.
 */
export function nextActionFor(row: BoardRow): { label: string; when: string | null } {
  const label = NEXT_ACTION_LABEL[row.status];
  if (row.status === "recovered") return { label, when: row.recovered_at };
  if (row.status === "chasing" || row.status === "escalated_voice" || row.status === "needs_human") {
    return { label, when: row.next_attempt_at };
  }
  return { label, when: null };
}

/* ── channel ─────────────────────────────────────────────────────────────── */

/**
 * The channel a customer was reached on, as the service's own mark.
 *
 * The brand logos are more legible at this size than a generic envelope or
 * handset would be - people recognise them without reading, which is the whole
 * job of a column you scan rather than read. So no text label: the mark alone
 * carries it, and `title` plus `alt` keep it available to a screen reader and
 * on hover.
 */
export const CHANNEL_ICON: Record<string, { src: string; label: string }> = {
  email: { src: "/icons/email.png", label: "Email" },
  whatsapp: { src: "/icons/whatsapp.png", label: "WhatsApp" },
  voice: { src: "/icons/voice.png", label: "Call" },
};

export function ChannelMark({ channel, size = 18 }: { channel: string | null; size?: number }) {
  if (!channel) {
    return (
      <span className="text-muted-foreground/70 text-sm" title="Nothing has reached them yet">
        —
      </span>
    );
  }

  const icon = CHANNEL_ICON[channel];
  if (!icon) return <span className="text-muted-foreground/70 text-sm">—</span>;

  return (
    <Image
      src={icon.src}
      alt={icon.label}
      title={`Last reached by ${icon.label}`}
      width={size}
      height={size}
      className="shrink-0 rounded-[4px]"
      unoptimized
    />
  );
}

export function StatusBadge({
  status, className, variant = "badge",
}: {
  status: BoardStatus;
  className?: string;
  /** "plain" renders a dot + coloured text with no badge box, for a table
   * column read at a glance rather than a status worn like a tag. */
  variant?: "badge" | "plain";
}) {
  const meta = STATUS_META[status];
  if (variant === "plain") {
    return (
      <span className={cn("inline-flex items-center gap-1.5 text-sm font-medium", STATUS_TEXT_CLASS[meta.token], className)}>
        <span className={cn("size-1.5 shrink-0 rounded-full", DOT_CLASS[meta.token])} aria-hidden="true" />
        {meta.label}
      </span>
    );
  }
  return (
    <Badge variant="outline" className={cn("gap-1.5 font-medium", STATUS_CLASS[meta.token], className)}>
      <span className={cn("size-1.5 rounded-full", DOT_CLASS[meta.token])} aria-hidden="true" />
      {meta.label}
    </Badge>
  );
}

/* ── workflows ───────────────────────────────────────────────────────────── */

/**
 * A short name for the table column, where the full label does not fit.
 * The pills and the settings screen carry the full one.
 */
export const WORKFLOW_SHORT: Record<WorkflowId, string> = {
  checkout_abandonment: "Checkout",
  failed_payment: "Failed payment",
  subscription_autopay: "Subscription",
  overdue_invoice: "Overdue invoice",
};

export const WORKFLOW_CLASS: Record<WorkflowId, string> = {
  checkout_abandonment:
    "bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/50 dark:text-sky-400 dark:border-sky-900",
  failed_payment:
    "bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/50 dark:text-orange-400 dark:border-orange-900",
  subscription_autopay:
    "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/50 dark:text-violet-400 dark:border-violet-900",
  overdue_invoice:
    "bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-950/50 dark:text-teal-400 dark:border-teal-900",
};

/** Which workflow handled one case. Null is the promise-to-pay path - see workflowFor. */
export function WorkflowBadge({
  workflow, className,
}: {
  workflow: WorkflowId | null;
  className?: string;
}) {
  if (!workflow) {
    return (
      <Badge
        variant="secondary"
        className={cn("text-xs", className)}
        title="Raised from a promise the customer made in conversation. Runs whatever the workflow settings say."
      >
        Promise to pay
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className={cn("text-xs", WORKFLOW_CLASS[workflow], className)}
      title={WORKFLOWS[workflow].label}
    >
      {WORKFLOW_SHORT[workflow]}
    </Badge>
  );
}

/**
 * The active-workflows indicator.
 *
 * Shows all four rather than only the enabled ones: "which am I not running"
 * is the question this answers, and a row that silently omits the off ones
 * cannot answer it.
 */
export function WorkflowPills({ enabled, slug }: { enabled: WorkflowId[]; slug: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
        Workflows
      </span>
      {WORKFLOW_IDS.map((id) => {
        const on = enabled.includes(id);
        return (
          <Badge
            key={id}
            variant="outline"
            className={cn(
              "gap-1.5 font-medium",
              on ? WORKFLOW_CLASS[id] : "text-muted-foreground/70 border-dashed",
            )}
            title={on ? WORKFLOWS[id].summary : `Off — ${WORKFLOWS[id].summary}`}
          >
            <span
              className={cn(
                "size-1.5 rounded-full",
                on ? "bg-current" : "bg-muted-foreground/40",
              )}
              aria-hidden="true"
            />
            {WORKFLOWS[id].label}
            {!on && <span className="text-[0.65rem] uppercase">off</span>}
          </Badge>
        );
      })}
      <Link
        href={`/dashboard/${slug}/settings`}
        className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
      >
        Change
      </Link>
    </div>
  );
}

/* ── why the agent stopped ───────────────────────────────────────────────── */

/**
 * Stop reasons in the merchant's words.
 *
 * These are written as what happened and what it means for them, not as the
 * enum: "Needs human" on its own does not distinguish a fraud flag from a
 * customer who has failed three cycles, and those want opposite responses.
 * Anything unmapped falls back to the raw value with its underscores
 * stripped, so a new reason degrades to readable rather than to blank.
 */
export const STOP_REASON_LABEL: Record<string, string> = {
  repeat_failure_across_cycles: "Failed repeatedly - handed to a human",
  customer_claims_paid: "Customer says they already paid - check the account",
  risk_flagged: "Blocked by fraud checks - handed to a human",
  admin_escalated: "Escalated by an admin",
  customer_opted_out: "Customer opted out",
  no_contact_details: "No email or phone on file",
  max_attempts_reached: "Attempt limit reached",
  no_channels_enabled: "No channels switched on",
  workflow_disabled: "This workflow is switched off",
  agent_chose_stop: "Agent judged further contact pointless",
  escalated_to_human: "Handed to a human",
  admin_disputed: "Flagged as disputed",
  admin_written_off: "Written off",
  merchant_missing: "Business record missing",
};

export function stopReasonLabel(reason: string | null): string | null {
  if (!reason) return null;
  return STOP_REASON_LABEL[reason] ?? reason.replace(/_/g, " ");
}

/* ── admin overrides ─────────────────────────────────────────────────────── */

/**
 * Lives here rather than beside the kebab menu because the timeline's
 * admin-action card needs the same icon for the same action, and importing
 * the menu into the detail panel just for an icon map would tie the two
 * together for no reason.
 */
export const ADMIN_ACTION_ICON: Record<AdminActionId, React.ComponentType<{ className?: string }>> = {
  mark_paid: CircleCheckIcon,
  pause_outreach: PauseIcon,
  resume_outreach: PlayIcon,
  escalate_human: UserIcon,
  flag_disputed: FlagIcon,
  snooze: CalendarClockIcon,
  trigger_next_step: FastForwardIcon,
  write_off: ArchiveIcon,
  opt_out: BanIcon,
  reopen_case: Undo2Icon,
};
