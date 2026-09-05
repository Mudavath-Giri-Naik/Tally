"use client";

/**
 * Audit Trail: every row Tally has ever written to `actions`, for this
 * merchant, most recent first - the single canonical place to read a
 * guardrail or clamp reason, now that the customer detail panel no longer
 * surfaces it inline.
 *
 * Server-paginated rather than loaded whole and sliced client-side, the way
 * the Customers table does it: this table has no natural ceiling on how many
 * rows it grows to, where the board is bounded by the date-range picker.
 */
import { useEffect, useState } from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  ScrollTextIcon,
  TriangleAlertIcon,
} from "lucide-react";

import type { ActionType, AuditRow } from "@/lib/audit";
import { ACTION_TYPES } from "@/lib/audit";
import type { Invariant, SendHour } from "@/lib/evidence";
import type { ChannelPerformance } from "@/lib/insights";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChannelMark, CHANNEL_ICON, shortTime } from "@/components/case-parts";

const PAGE_SIZE = 25;

const TYPE_LABEL: Record<ActionType, string> = {
  sent: "Sent",
  blocked: "Blocked",
  escalated: "Escalated",
  inaction: "Inaction",
};

const OUTCOME_LABEL: Record<string, string> = {
  sent: "Sent",
  delivered: "Delivered",
  failed: "Send failed",
  skipped: "Blocked by a guardrail",
  escalated: "Escalated to a human",
  no_action: "No action taken",
  pending: "Pending",
};

/* ── did it behave ───────────────────────────────────────────────────────── */

function InvariantRow({ inv }: { inv: Invariant }) {
  return (
    <div className="flex items-start gap-2.5 py-1.5">
      {inv.held ? (
        <CircleCheckIcon
          className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
          aria-hidden="true"
        />
      ) : (
        <TriangleAlertIcon
          className="mt-0.5 size-4 shrink-0 text-red-600 dark:text-red-400"
          aria-hidden="true"
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm">{inv.claim}</span>
        {!inv.held && (
          <span className="mt-0.5 text-xs text-red-600 dark:text-red-400">
            {inv.breaches} {inv.breach}
          </span>
        )}
      </div>
      <span className="sr-only">{inv.held ? "held" : "breached"}</span>
    </div>
  );
}

/**
 * Every rule, checked against the rows themselves - moved here from the old
 * standalone Evidence page, since this is exactly the aggregate the row-level
 * guardrail reasons below add up to.
 */
function RulesCard({ invariants }: { invariants: Invariant[] }) {
  const broken = invariants.filter((i) => !i.held).length;
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Every rule, checked against your data</CardTitle>
          <Badge
            variant="outline"
            className={cn(
              broken === 0
                ? "border-emerald-500 text-emerald-600 dark:text-emerald-400"
                : "border-red-500 text-red-600 dark:text-red-400",
            )}
          >
            {broken === 0 ? "All held" : `${broken} broken`}
          </Badge>
        </div>
        <p className="text-muted-foreground text-sm">
          Run against the rows themselves, not against anything the agent
          recorded about its own behaviour - an agent reporting a clean week is
          exactly what a bug in it would also produce.
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid gap-x-6 sm:grid-cols-2">
          {invariants.map((i) => (
            <InvariantRow key={i.id} inv={i} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * When messages actually went out, against the window you promised.
 *
 * Drawn to one scale across all twenty-four hours, including the empty ones -
 * the silent hours are the entire point.
 */
function WindowCard({
  hours, window, timezone, breaches, channels,
}: {
  hours: SendHour[];
  window: { start: string; end: string };
  timezone: string;
  breaches: number;
  channels: ChannelPerformance[];
}) {
  const peak = Math.max(1, ...hours.map((h) => h.sends));
  const totalSent = hours.reduce((sum, h) => sum + h.sends, 0);
  const inWindowSent = hours
    .filter((h) => h.inWindow)
    .reduce((sum, h) => sum + h.sends, 0);
  const busiest = hours.reduce((best, h) => (h.sends > best.sends ? h : best), hours[0]);
  const channelPeak = Math.max(1, ...channels.map((c) => c.sent));

  return (
    <Card>
      <CardHeader>
        <CardTitle>When messages actually went out</CardTitle>
        <p className="text-muted-foreground text-sm">
          Local hours in {timezone}. The shaded band is your contact window,{" "}
          {window.start.slice(0, 5)}–{window.end.slice(0, 5)}.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="overflow-x-auto">
          <div className="flex min-w-[34rem] items-end gap-[3px]" role="img"
               aria-label={`Messages sent by hour of day in ${timezone}`}>
            {hours.map((h) => (
              <div key={h.hour} className="flex flex-1 flex-col items-center gap-1">
                <span className="text-muted-foreground text-[0.6rem] tabular-nums">
                  {h.sends > 0 ? h.sends : ""}
                </span>
                <div
                  className={cn(
                    "w-full rounded-sm",
                    h.sends === 0
                      ? "bg-muted"
                      : h.inWindow
                        ? "bg-emerald-500"
                        : "bg-red-500",
                  )}
                  style={{ height: `${Math.max(2, (h.sends / peak) * 72)}px` }}
                />
                <span
                  className={cn(
                    "text-[0.6rem] tabular-nums",
                    h.inWindow ? "text-foreground font-medium" : "text-muted-foreground",
                  )}
                >
                  {String(h.hour).padStart(2, "0")}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-3 divide-x rounded-lg border">
          <div className="flex flex-col items-center gap-0.5 px-2 py-3 text-center">
            <span className="text-xl font-semibold tabular-nums">{totalSent}</span>
            <span className="text-muted-foreground text-xs">
              message{totalSent === 1 ? "" : "s"} sent
            </span>
          </div>
          <div className="flex flex-col items-center gap-0.5 px-2 py-3 text-center">
            <span className="text-xl font-semibold tabular-nums">
              {totalSent === 0 ? "—" : `${String(busiest.hour).padStart(2, "0")}:00`}
            </span>
            <span className="text-muted-foreground text-xs">busiest hour</span>
          </div>
          <div className="flex flex-col items-center gap-0.5 px-2 py-3 text-center">
            <span className="text-xl font-semibold tabular-nums">
              {totalSent === 0 ? "—" : `${Math.round((inWindowSent / totalSent) * 100)}%`}
            </span>
            <span className="text-muted-foreground text-xs">landed in window</span>
          </div>
        </div>

        {channels.length > 0 && (
          <div className="flex flex-col gap-2.5 rounded-lg border p-3">
            <span className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
              Delivery by channel
            </span>
            <div className="flex flex-col gap-2">
              {channels.map((c) => (
                <div key={c.channel} className="flex items-center gap-2.5">
                  <ChannelMark channel={c.channel} size={16} />
                  <span className="w-16 shrink-0 text-xs">
                    {CHANNEL_ICON[c.channel]?.label ?? c.channel}
                  </span>
                  <div className="bg-muted h-1.5 flex-1 overflow-hidden rounded-full">
                    <div
                      className="h-full rounded-full bg-sky-500"
                      style={{ width: `${Math.max(4, (c.sent / channelPeak) * 100)}%` }}
                    />
                  </div>
                  <span className="w-6 shrink-0 text-right text-xs tabular-nums">
                    {c.sent}
                  </span>
                  <span className="w-16 shrink-0 text-right text-xs tabular-nums">
                    {c.failed > 0 ? (
                      <span className="text-red-600 dark:text-red-400">
                        {c.failed} failed
                      </span>
                    ) : (
                      <span className="text-muted-foreground">0 failed</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <p className="text-sm">
          {breaches === 0 ? (
            <span className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
              <CircleCheckIcon className="size-4 shrink-0" aria-hidden="true" />
              Every message landed inside the window.
            </span>
          ) : (
            <span className="flex items-center gap-2 text-red-600 dark:text-red-400">
              <TriangleAlertIcon className="size-4 shrink-0" aria-hidden="true" />
              {breaches} message{breaches === 1 ? "" : "s"} landed outside it.
            </span>
          )}
        </p>
      </CardContent>
    </Card>
  );
}

function CompliancePill({ inWindow }: { inWindow: boolean | null }) {
  if (inWindow === null) {
    return <span className="text-muted-foreground text-xs">—</span>;
  }
  return (
    <Badge
      variant="outline"
      className={
        inWindow
          ? "border-emerald-200 bg-emerald-50 text-xs text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400"
          : "border-red-200 bg-red-50 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400"
      }
    >
      {inWindow ? "Pass" : "Fail"}
    </Badge>
  );
}

export function AuditTrail({
  slug,
  customers,
  invariants,
  hours,
  channels,
  window,
  timezone,
}: {
  slug: string;
  customers: Array<{ id: string; name: string | null }>;
  invariants: Invariant[];
  hours: SendHour[];
  channels: ChannelPerformance[];
  window: { start: string; end: string };
  timezone: string;
}) {
  const [customerId, setCustomerId] = useState("all");
  const [type, setType] = useState("all");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Any narrowing invalidates the page number: page 3 of the old filter is
  // not page 3 of the new one.
  useEffect(() => setPage(0), [customerId, type]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
    });
    if (customerId !== "all") params.set("customer", customerId);
    if (type !== "all") params.set("type", type);

    fetch(`/api/dashboard/${slug}/actions?${params}`)
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json() as Promise<{ rows: AuditRow[]; total: number }>;
      })
      .then((json) => {
        if (cancelled) return;
        setRows(json.rows);
        setTotal(json.total);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load the audit trail. Try again.");
      });

    return () => {
      cancelled = true;
    };
  }, [slug, customerId, type, page]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const to = Math.min((page + 1) * PAGE_SIZE, total);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <ScrollTextIcon className="text-muted-foreground size-6" />
          Audit Trail
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Every action Tally has recorded for this business, including the
          decisions where it deliberately did nothing - most recent first.
        </p>
      </div>

      <div className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold tracking-tight">Did it behave?</h2>
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <RulesCard invariants={invariants} />
          <WindowCard
            hours={hours}
            window={window}
            timezone={timezone}
            breaches={invariants.find((i) => i.id === "contact_window")?.breaches ?? 0}
            channels={channels}
          />
        </div>
      </div>

      <Card className="gap-0 py-0">
        <div className="flex flex-wrap items-center gap-2 border-b p-4 sm:px-6">
          <Select
            items={[
              { value: "all", label: "All customers" },
              ...customers.map((c) => ({ value: c.id, label: c.name ?? "Unknown customer" })),
            ]}
            value={customerId}
            onValueChange={(v) => setCustomerId(v ?? "all")}
          >
            <SelectTrigger className="w-[220px] rounded-full">
              <SelectValue placeholder="All customers" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All customers</SelectItem>
              {customers.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name ?? "Unknown customer"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            items={[
              { value: "all", label: "All actions" },
              ...ACTION_TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] })),
            ]}
            value={type}
            onValueChange={(v) => setType(v ?? "all")}
          >
            <SelectTrigger className="w-[160px] rounded-full">
              <SelectValue placeholder="All actions" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All actions</SelectItem>
              {ACTION_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {TYPE_LABEL[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {error ? (
          <p className="text-destructive p-12 text-center text-sm">{error}</p>
        ) : rows === null ? (
          <p className="text-muted-foreground p-12 text-center text-sm">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground p-12 text-center text-sm">
            Nothing matches these filters.
          </p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Time</TableHead>
                  <TableHead className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Customer</TableHead>
                  <TableHead className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Channel</TableHead>
                  <TableHead className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Action taken</TableHead>
                  <TableHead className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Guardrail reason</TableHead>
                  <TableHead className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Contact window</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="text-muted-foreground text-xs whitespace-nowrap tabular-nums">
                      {shortTime(r.created_at)}
                    </TableCell>
                    <TableCell className="font-medium">
                      {r.customer_name ?? "Unknown customer"}
                    </TableCell>
                    <TableCell>
                      <ChannelMark channel={r.channel} size={16} />
                    </TableCell>
                    <TableCell className="max-w-xs">
                      <div className="text-sm font-medium">
                        {OUTCOME_LABEL[r.outcome] ?? r.outcome.replace(/_/g, " ")}
                      </div>
                      {r.rationale && (
                        <div className="text-muted-foreground mt-0.5 text-xs">{r.rationale}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      {r.guardrail ? (
                        <Badge variant="secondary" className="text-xs">
                          {r.guardrail.replace(/_/g, " ")}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <CompliancePill inWindow={r.in_window} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t p-4 sm:px-6">
              <span className="text-muted-foreground text-sm tabular-nums">
                Showing {from}–{to} of {total} actions
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  className="rounded-lg"
                  disabled={page <= 0}
                  onClick={() => setPage((p) => p - 1)}
                  aria-label="Previous page"
                >
                  <ChevronLeftIcon className="size-4" />
                </Button>
                <span className="text-muted-foreground px-2 text-sm tabular-nums">
                  Page {page + 1} of {pages}
                </span>
                <Button
                  variant="outline"
                  size="icon"
                  className="rounded-lg"
                  disabled={page + 1 >= pages}
                  onClick={() => setPage((p) => p + 1)}
                  aria-label="Next page"
                >
                  <ChevronRightIcon className="size-4" />
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
