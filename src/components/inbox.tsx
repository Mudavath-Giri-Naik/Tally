"use client";

/**
 * Inbox: every case waiting on a person, ranked by what's at stake.
 *
 * The Customers table answers "what happened, to whom" for every case at
 * once, which is exactly wrong for the one question this page exists to
 * answer instead - "what needs me right now" - since finding that meant
 * setting a status filter and re-reading a dense table for it. This is that
 * answer, already filtered and already sorted, so the tab itself is the
 * whole triage rather than a starting point for one.
 *
 * Deliberately not the Customers table with a filter pre-applied: each case
 * gets a full card because a merchant is about to decide something about it,
 * not scan past it, and the kebab menu that resolves it is right there
 * rather than at the end of a row that has already scrolled off-screen.
 *
 * Reuses the exact same override dialog and API route the Customers table
 * uses - a quick action taken from here and one taken from there produce
 * identical rows, because they are the same code path.
 */
import Link from "next/link";
import { useCallback, useState } from "react";

import { formatINR } from "@/lib/types";
import { buildInbox } from "@/lib/inbox";
import type { Dashboard, BoardRow } from "@/lib/board";
import { useDashboardStream } from "@/hooks/use-dashboard-stream";
import { cn } from "@/lib/utils";
import {
  initials,
  avatarTone,
  relativeTime,
  stopReasonLabel,
  ChannelMark,
} from "@/components/case-parts";
import { RowActionsMenu, AdminActionDialog } from "@/components/case-actions";
import type { AdminActionDef } from "@/lib/admin-actions";
import { ArrowUpRightIcon, InboxIcon, PartyPopperIcon } from "lucide-react";

/** Red for a fraud flag or a dispute - the two a merchant reads as urgent -
 *  amber for everything else that has simply run out of automated road. */
function urgencyTone(row: BoardRow): "red" | "amber" {
  return row.status === "disputed" || row.stop_reason === "risk_flagged" ? "red" : "amber";
}

function InboxCard({
  slug, row, onOpenAction,
}: {
  slug: string;
  row: BoardRow;
  onOpenAction: (row: BoardRow, action: AdminActionDef) => void;
}) {
  const tone = urgencyTone(row);
  const why = stopReasonLabel(row.stop_reason) ?? "Stopped automating";

  return (
    <div className="flex items-start gap-3 rounded-xl border bg-card p-4 shadow-sm transition hover:shadow-md">
      <span
        className={cn(
          "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white",
          avatarTone(row.customer_id ?? row.event_id),
        )}
      >
        {initials(row.customer_name)}
      </span>

      <Link
        href={`/dashboard/${slug}/customers?open=${row.event_id}&range=90`}
        className="min-w-0 flex-1"
      >
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-semibold">{row.customer_name ?? "Unknown customer"}</span>
          <span className="text-muted-foreground text-xs">
            {row.customer_email ?? row.customer_phone ?? "no contact on file"}
          </span>
          <span className="ml-auto text-base font-bold tabular-nums">
            {formatINR(row.amount)}
          </span>
        </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-xs font-semibold",
              tone === "red"
                ? "bg-red-500/10 text-red-600 dark:text-red-400"
                : "bg-amber-500/10 text-amber-600 dark:text-amber-400",
            )}
          >
            {why}
          </span>
          <Badge>{row.reason_label}</Badge>
          <ChannelMark channel={row.last_channel} size={15} />
        </div>

        <p className="text-muted-foreground mt-1.5 text-xs">
          Failed {relativeTime(row.failed_on)} · {row.attempts} of {row.max_attempts} attempts ·{" "}
          <span className="inline-flex items-center gap-1 font-medium">
            open the full case <ArrowUpRightIcon className="size-3" />
          </span>
        </p>
      </Link>

      <div onClick={(e) => e.stopPropagation()}>
        <RowActionsMenu row={row} onOpenAction={(action) => onOpenAction(row, action)} />
      </div>
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs font-medium">
      {children}
    </span>
  );
}

export function Inbox({ slug, initial }: { slug: string; initial: Dashboard }) {
  const { data, setData } = useDashboardStream(slug, initial);
  const [overrideTarget, setOverrideTarget] = useState<
    { row: BoardRow; action: AdminActionDef } | null
  >(null);

  const queue = buildInbox(data.rows);
  const atRisk = queue.reduce((sum, r) => sum + (r.amount ?? 0), 0);

  /** Identical to CaseBoard's own submitOverride - same endpoint, same
   *  merge-back, so a card resolved here and a row resolved in Customers
   *  leave the exact same trail. No timeline to refresh here, since the
   *  Inbox card itself shows none - only the row updates. */
  const submitOverride = useCallback(
    async (
      row: BoardRow,
      action: AdminActionDef,
      payload: { reasonText: string | null; snoozeUntil: string | null },
    ): Promise<string | null> => {
      try {
        const res = await fetch(`/api/dashboard/${slug}/events/${row.event_id}/override`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: action.id, ...payload }),
        });
        const json = (await res.json()) as { row?: BoardRow; error?: string };
        if (!res.ok || !json.row) return json.error ?? "That action could not be applied.";
        const updated = json.row;
        setData((d) => ({
          ...d,
          rows: d.rows.map((r) => (r.event_id === updated.event_id ? updated : r)),
        }));
        return null;
      } catch {
        return "That action could not be applied. Try again.";
      }
    },
    [slug, setData],
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <InboxIcon className="text-muted-foreground size-6" />
          Inbox
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Every case the agent has stopped automating and handed to a person -
          ranked by what is at stake, not by when it happened.
        </p>
      </div>

      {queue.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-16 text-center">
          <PartyPopperIcon className="text-muted-foreground size-8" />
          <p className="font-semibold">Nothing waiting on you</p>
          <p className="text-muted-foreground max-w-sm text-sm">
            Every open case is still something the agent is handling on its
            own. This tab only fills up when it genuinely can't go further
            without you.
          </p>
        </div>
      ) : (
        <>
          <div className="text-muted-foreground flex items-center gap-1.5 text-sm">
            <span className="text-foreground font-semibold">{queue.length}</span>
            {queue.length === 1 ? "case" : "cases"} waiting on you ·{" "}
            <span className="text-foreground font-semibold">{formatINR(atRisk)}</span> at stake
          </div>

          <div className="flex flex-col gap-3">
            {queue.map((row) => (
              <InboxCard
                key={row.event_id}
                slug={slug}
                row={row}
                onOpenAction={(r, a) => setOverrideTarget({ row: r, action: a })}
              />
            ))}
          </div>
        </>
      )}

      {overrideTarget && (
        <AdminActionDialog
          row={overrideTarget.row}
          action={overrideTarget.action}
          onClose={() => setOverrideTarget(null)}
          onSubmit={(payload) =>
            submitOverride(overrideTarget.row, overrideTarget.action, payload)
          }
        />
      )}
    </div>
  );
}
