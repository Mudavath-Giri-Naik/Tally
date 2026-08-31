"use client";

/**
 * The case board: every case for this business, as a table you can filter and act on.
 *
 * Shared between Overview (below the metrics and charts) and the Customers
 * page (which is just this plus its own top bar) - one table, one set of
 * filters, one detail panel, rather than two copies that could drift apart.
 *
 * Filtering, searching and paging are local to the browser: the rows are
 * already here, so narrowing them is a render rather than a request.
 */
import { Dispatch, SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  CalendarClockIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  PauseIcon,
  SearchIcon,
} from "lucide-react";

import { formatINR } from "@/lib/types";
import {
  BOARD_STATUSES,
  STATUS_META,
  type Dashboard,
  type BoardRow,
  type BoardStatus,
  type TimelineEntry,
} from "@/lib/board";
import { WORKFLOWS } from "@/lib/workflows";
import type { AdminActionDef } from "@/lib/admin-actions";
import { cn } from "@/lib/utils";
import { useSidebar } from "@/components/ui/sidebar";
import { Card, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import {
  ChannelMark,
  DOT_CLASS,
  STATUS_CLASS,
  StatusBadge,
  WorkflowBadge,
  initials,
  shortDate,
  shortTime,
  stopReasonLabel,
} from "@/components/case-parts";
import { DetailPanel } from "@/components/case-detail";
import { AdminActionDialog, RowActionsMenu } from "@/components/case-actions";

const PAGE_SIZE = 8;

export function CaseBoard({
  slug, data, setData,
}: {
  slug: string;
  data: Dashboard;
  setData: Dispatch<SetStateAction<Dashboard>>;
}) {
  const [tab, setTab] = useState<BoardStatus | "all">("all");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [channelFilter, setChannelFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [openEvent, setOpenEvent] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[] | null>(null);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [overrideTarget, setOverrideTarget] =
    useState<{ row: BoardRow; action: AdminActionDef } | null>(null);

  const { isMobile, setOpen: setSidebarOpen } = useSidebar();


  // The nav rail and the detail panel are both competing for width, so the
  // rail collapses to icons for as long as the panel is open - on mobile the
  // rail is already off-canvas and never competes for space, so it is left
  // alone there.
  //
  // setSidebarOpen is read through a ref rather than listed as a dependency:
  // SidebarProvider hands back a new function identity every time `open`
  // changes, including from a manual click on the trigger, so depending on
  // it directly would re-run this effect on every toggle and immediately
  // snap the rail back to !openEvent - the trigger would look broken because
  // it would be, fighting whatever the merchant just clicked.
  const setSidebarOpenRef = useRef(setSidebarOpen);
  setSidebarOpenRef.current = setSidebarOpen;
  useEffect(() => {
    if (isMobile) return;
    setSidebarOpenRef.current(!openEvent);
  }, [openEvent, isMobile]);

  // Leaving this page must not strand the rail collapsed on whichever page
  // has no panel competing for the width. Held in a ref so the unmount
  // cleanup is not re-armed every time isMobile changes.
  const restoreRail = useRef<() => void>(() => {});
  restoreRail.current = () => {
    if (!isMobile) setSidebarOpen(true);
  };
  useEffect(() => () => restoreRail.current(), []);

  const matches = useCallback(
    (r: BoardRow) => {
      const q = query.trim().toLowerCase();
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (channelFilter !== "all" && (r.last_channel ?? "none") !== channelFilter) return false;
      if (!q) return true;
      const amount = r.amount === null ? "" : String(Math.round(r.amount / 100));
      const workflow = r.workflow ? WORKFLOWS[r.workflow].label : "promise to pay";
      return (
        (r.customer_name ?? "").toLowerCase().includes(q) ||
        r.reason_label.toLowerCase().includes(q) ||
        r.reason.toLowerCase().includes(q) ||
        workflow.toLowerCase().includes(q) ||
        amount.includes(q)
      );
    },
    [query, statusFilter, channelFilter],
  );

  // Counts describe the search results, not the whole table - a count that
  // ignored the active search would send someone to an empty tab.
  const counts = useMemo(() => {
    const base = data.rows.filter(matches);
    const out: Record<string, number> = { all: base.length };
    for (const s of BOARD_STATUSES) out[s] = 0;
    for (const r of base) out[r.status] = (out[r.status] ?? 0) + 1;
    return out;
  }, [data.rows, matches]);

  const filtered = useMemo(
    () => data.rows.filter((r) => matches(r) && (tab === "all" || r.status === tab)),
    [data.rows, matches, tab],
  );

  // Any narrowing invalidates the page number: page 3 of the old result set is
  // not page 3 of the new one.
  useEffect(() => setPage(1), [query, statusFilter, channelFilter, tab]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pages);
  const visible = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const from = filtered.length === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1;
  const to = Math.min(safePage * PAGE_SIZE, filtered.length);

  const openRow = useMemo(
    () => data.rows.find((r) => r.event_id === openEvent) ?? null,
    [data.rows, openEvent],
  );

  const loadTimeline = useCallback(
    async (eventId: string) => {
      setTimeline(null);
      setTimelineError(null);
      try {
        const res = await fetch(`/api/dashboard/${slug}/timeline/${eventId}`);
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as { entries: TimelineEntry[] };
        setTimeline(json.entries);
      } catch {
        setTimelineError("That timeline could not be loaded. Try again.");
      }
    },
    [slug],
  );

  const toggleRow = useCallback(
    async (eventId: string) => {
      if (openEvent === eventId) { setOpenEvent(null); return; }
      setOpenEvent(eventId);
      await loadTimeline(eventId);
    },
    [openEvent, loadTimeline],
  );

  /**
   * Run one admin override, merge the fresh row back in immediately (no
   * refetch of the whole board), and reload the timeline if that case's
   * panel happens to be open - the new "admin action" card should appear
   * without the merchant having to close and reopen the row.
   */
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
        if (openEvent === updated.event_id) await loadTimeline(updated.event_id);
        return null;
      } catch {
        return "That action could not be applied. Try again.";
      }
    },
    [slug, openEvent, loadTimeline, setData],
  );

  return (
    // A grid, not a flex row: a flex item with a fixed width refuses to
    // shrink below it (or, with min-w-0, shrinks all the way to nothing,
    // which is how the table's own search box ended up clipped earlier).
    // minmax(0, 400px) has no such failure mode - the track's floor is 0, so
    // the panel narrows to fit whatever room is actually left instead of
    // ever pushing the row wider than its container. No viewport breakpoint,
    // sidebar width, or zoom level can make this overflow.
    <div className={cn("grid gap-6", openRow && "lg:grid-cols-[minmax(320px,1fr)_minmax(0,400px)]")}>
      <Card className="min-w-0 gap-0 py-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4 sm:p-6">
          <CardTitle>All cases</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by customer name"
                aria-label="Search customers"
                className="w-[260px] pl-9"
              />
            </div>
            <Select
              value={statusFilter}
              onValueChange={(v) => { setStatusFilter(v ?? "all"); setTab("all"); }}
            >
              <SelectTrigger className="w-[152px]">
                <SelectValue placeholder="All status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All status</SelectItem>
                {BOARD_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>{STATUS_META[s].label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={channelFilter} onValueChange={(v) => setChannelFilter(v ?? "all")}>
              <SelectTrigger className="w-[152px]">
                <SelectValue placeholder="All channels" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All channels</SelectItem>
                <SelectItem value="email">Email</SelectItem>
                <SelectItem value="whatsapp">WhatsApp</SelectItem>
                <SelectItem value="voice">Voice</SelectItem>
                <SelectItem value="none">Not reached</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="border-b px-4 py-3 sm:px-6">
          <Tabs
            value={tab}
            onValueChange={(v) => { setTab(v as BoardStatus | "all"); setStatusFilter("all"); }}
          >
            <TabsList className="h-auto flex-wrap">
              <TabsTrigger value="all">
                All customers
                <span className="text-muted-foreground ml-1.5 tabular-nums">{counts.all}</span>
              </TabsTrigger>
              {BOARD_STATUSES.map((s) => (
                <TabsTrigger key={s} value={s}>
                  <span
                    className={cn("size-1.5 rounded-full", DOT_CLASS[STATUS_META[s].token])}
                    aria-hidden="true"
                  />
                  {STATUS_META[s].label}
                  <span className="text-muted-foreground ml-1 tabular-nums">
                    {counts[s] ?? 0}
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>

        {visible.length === 0 ? (
          <p className="text-muted-foreground p-12 text-center text-sm">
            {data.rows.length === 0
              ? "No events in this window. The first failed payment on your Razorpay account appears here within a minute."
              : "Nothing matches these filters."}
          </p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Customer</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Workflow</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Attempts</TableHead>
                  <TableHead>Failed on</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((row) => (
                  <TableRow
                    key={row.event_id}
                    onClick={() => void toggleRow(row.event_id)}
                    tabIndex={0}
                    role="button"
                    aria-expanded={openEvent === row.event_id}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        void toggleRow(row.event_id);
                      }
                    }}
                    className={cn(
                      "cursor-pointer",
                      openEvent === row.event_id && "bg-muted/60",
                    )}
                  >
                    <TableCell>
                      <div className="flex items-center gap-2.5">
                        <Avatar className="size-7">
                          <AvatarImage src="/icons/user.png" alt={row.customer_name ?? "Unknown"} />
                          <AvatarFallback className="text-[0.65rem] font-bold">
                            {initials(row.customer_name)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="font-medium">{row.customer_name ?? "Unknown"}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">
                      {formatINR(row.amount)}
                    </TableCell>
                    <TableCell><WorkflowBadge workflow={row.workflow} /></TableCell>
                    <TableCell><Badge variant="secondary">{row.reason_label}</Badge></TableCell>
                    <TableCell><ChannelMark channel={row.last_channel} /></TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <StatusBadge status={row.status} />
                        {/* "Needs human" covers a fraud flag, three failed
                            cycles and an admin escalation alike - which one
                            it was decides what the merchant should do. */}
                        {row.stop_reason && (
                          <span
                            className="text-muted-foreground text-xs"
                            title={stopReasonLabel(row.stop_reason) ?? undefined}
                          >
                            {stopReasonLabel(row.stop_reason)}
                          </span>
                        )}
                        {row.paused && (
                          <Badge variant="outline" className="gap-1 text-xs">
                            <PauseIcon className="size-3" />Paused
                          </Badge>
                        )}
                        {!row.paused &&
                          row.hold_until &&
                          Date.parse(row.hold_until) > Date.now() && (
                            <Badge variant="outline" className="gap-1 text-xs">
                              <CalendarClockIcon className="size-3" />Snoozed
                            </Badge>
                          )}
                        {/* Distinct from "Snoozed" (an admin's own hold) - this is
                            the worker's own next scheduled step, e.g. a message
                            deferred until the contact window reopens. Without it
                            a case that has genuinely done nothing yet looks
                            identical to one silently waiting on the clock. */}
                        {!row.paused &&
                          !(row.hold_until && Date.parse(row.hold_until) > Date.now()) &&
                          row.next_attempt_at &&
                          Date.parse(row.next_attempt_at) > Date.now() && (
                            <Badge
                              variant="outline"
                              className="gap-1 text-xs"
                              title={`Next attempt: ${shortTime(row.next_attempt_at)}`}
                            >
                              <ClockIcon className="size-3" />
                              Next {shortTime(row.next_attempt_at)}
                            </Badge>
                          )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge
                        variant="outline"
                        className={cn("tabular-nums", row.attempts >= row.max_attempts && STATUS_CLASS.chasing)}
                      >
                        {row.attempts}/{row.max_attempts}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
                      {shortDate(row.failed_on)}
                    </TableCell>
                    <TableCell className="text-right">
                      <RowActionsMenu
                        row={row}
                        onOpenAction={(action) => setOverrideTarget({ row, action })}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t p-4 sm:px-6">
              <span className="text-muted-foreground text-sm tabular-nums">
                Showing {from}–{to} of {filtered.length}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline" size="icon" disabled={safePage <= 1}
                  onClick={() => setPage(safePage - 1)} aria-label="Previous page"
                >
                  <ChevronLeftIcon className="size-4" />
                </Button>
                {Array.from({ length: pages }, (_, i) => i + 1)
                  .filter((n) => n === 1 || n === pages || Math.abs(n - safePage) <= 1)
                  .map((n, i, arr) => (
                    <span key={n} className="contents">
                      {i > 0 && arr[i - 1] !== n - 1 && (
                        <span className="text-muted-foreground px-1">…</span>
                      )}
                      <Button
                        variant={n === safePage ? "default" : "outline"}
                        size="icon" className="tabular-nums"
                        onClick={() => setPage(n)}
                      >
                        {n}
                      </Button>
                    </span>
                  ))}
                <Button
                  variant="outline" size="icon" disabled={safePage >= pages}
                  onClick={() => setPage(safePage + 1)} aria-label="Next page"
                >
                  <ChevronRightIcon className="size-4" />
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>

      {/* No height tied to the table's any more. The panel now carries the
          whole story - origin, every step, the plan, the actions - and pinning
          it to however tall the table happened to be cut that off whenever the
          table was the shorter of the two. It sizes to its own content
          instead, capped at the viewport so a long trail stays readable
          without chasing it up the page. */}
      {openRow && (
        <div className="min-w-0 lg:sticky lg:top-6">
          <DetailPanel
            row={openRow}
            entries={timeline}
            error={timelineError}
            onAction={(action) => setOverrideTarget({ row: openRow, action })}
          />
        </div>
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
