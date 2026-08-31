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

import { STATUS_META, type BoardStatus } from "@/lib/board";
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

/** Rupees, abbreviated the Indian way, for an axis where space is scarce. */
export function compactINR(paise: number): string {
  const r = paise / 100;
  if (r >= 1e7) return `₹${(r / 1e7).toFixed(r % 1e7 === 0 ? 0 : 1)}Cr`;
  if (r >= 1e5) return `₹${(r / 1e5).toFixed(r % 1e5 === 0 ? 0 : 1)}L`;
  if (r >= 1e3) return `₹${(r / 1e3).toFixed(r % 1e3 === 0 ? 0 : 1)}K`;
  return `₹${Math.round(r)}`;
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

export function StatusBadge({ status, className }: { status: BoardStatus; className?: string }) {
  const meta = STATUS_META[status];
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
