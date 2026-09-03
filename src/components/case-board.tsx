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
  FilterIcon,
  PauseIcon,
  SearchIcon,
  SlidersHorizontalIcon,
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
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
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
  StatusBadge,
  WORKFLOW_CLASS,
  RecoveryRing,
  avatarTone,
  initials,
  nextActionFor,
  recoveryChance,
  shortTime,
  stopReasonLabel,
} from "@/components/case-parts";
import { DetailPanel, type AdminChatTurn } from "@/components/case-detail";
import { AdminActionDialog, RowActionsMenu } from "@/components/case-actions";

const PAGE_SIZE = 8;

/** The status pill bar's active-tab fill, one shade per status token - kept
 * as full literal class strings (not built from DOT_CLASS at runtime) so
 * Tailwind's static scan can actually find them. */
const TAB_ACTIVE_CLASS: Record<string, string> = {
  recovered: "data-active:bg-emerald-500 data-active:text-white",
  chasing: "data-active:bg-amber-500 data-active:text-white",
  voice: "data-active:bg-blue-500 data-active:text-white",
  human: "data-active:bg-red-500 data-active:text-white",
  stopped: "data-active:bg-slate-500 data-active:text-white",
  disputed: "data-active:bg-purple-500 data-active:text-white",
  written_off: "data-active:bg-slate-600 data-active:text-white",
};

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
  const [reasonFilter, setReasonFilter] = useState("all");
  const [page, setPage] = useState(1);
  // Row checkboxes: purely a selection UI for now, scoped to this component -
  // there is no bulk-action bar yet to spend it on.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openEvent, setOpenEvent] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[] | null>(null);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [overrideTarget, setOverrideTarget] =
    useState<{ row: BoardRow; action: AdminActionDef } | null>(null);
  // Chat is kept per case rather than globally: the conversation is about
  // this case, and carrying it across to the next row would read as the agent
  // confusing two customers.
  const [chats, setChats] = useState<Record<string, AdminChatTurn[]>>({});
  const [asking, setAsking] = useState(false);
  // What the last instruction actually did. The stored turn carries the
  // words; this carries the receipt.
  const [lastResult, setLastResult] = useState<{
    action: string | null;
    performed: boolean;
    error: string | null;
    sentBody: string | null;
  } | null>(null);

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
      if (reasonFilter !== "all" && r.reason !== reasonFilter) return false;
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
    [query, statusFilter, channelFilter, reasonFilter],
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
  useEffect(() => setPage(1), [query, statusFilter, channelFilter, reasonFilter, tab]);

  // The reason dropdown's options: whatever reasons are actually present,
  // not the full enum - a merchant who has never seen "risk_declined" should
  // not have to scroll past it.
  const reasonOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of data.rows) if (!seen.has(r.reason)) seen.set(r.reason, r.reason_label);
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [data.rows]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pages);
  const visible = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const from = filtered.length === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1;
  const to = Math.min(safePage * PAGE_SIZE, filtered.length);

  const allVisibleSelected = visible.length > 0 && visible.every((r) => selected.has(r.event_id));
  const toggleAllVisible = useCallback(() => {
    setSelected((s) => {
      const next = new Set(s);
      if (allVisibleSelected) visible.forEach((r) => next.delete(r.event_id));
      else visible.forEach((r) => next.add(r.event_id));
      return next;
    });
  }, [allVisibleSelected, visible]);
  const toggleOne = useCallback((eventId: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(eventId)) next.delete(eventId);
      else next.add(eventId);
      return next;
    });
  }, []);

  const openRow = useMemo(
    () => data.rows.find((r) => r.event_id === openEvent) ?? null,
    [data.rows, openEvent],
  );

  /**
   * Refetch without clearing first.
   *
   * loadTimeline blanks the panel to show a spinner, which is right when
   * opening a case and wrong on a poll - it would flicker the whole story
   * away every ten seconds.
   */
  const loadTimelineQuietly = useCallback(
    async (eventId: string) => {
      try {
        const res = await fetch(`/api/dashboard/${slug}/timeline/${eventId}`);
        if (!res.ok) return;
        const json = (await res.json()) as { entries: TimelineEntry[] };
        setTimeline(json.entries);
      } catch {
        // A failed poll keeps whatever is on screen; the next one will do.
      }
    },
    [slug],
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

  /**
   * Keep the open case's trail current.
   *
   * The board itself arrives over SSE, but the timeline is fetched once when
   * a row is opened - so a customer replying on WhatsApp, or the worker
   * running a step, left the panel showing a story that had already moved on.
   * Ten seconds is frequent enough to feel live and rare enough to be free.
   */
  useEffect(() => {
    if (!openEvent || asking) return;

    // Four seconds, not ten: a customer's reply arriving is the thing a
    // merchant is sitting there waiting for, and ten made it feel like the
    // panel had missed it. The request is small and hits one index.
    const id = setInterval(() => {
      if (document.visibilityState === "visible") {
        void loadTimelineQuietly(openEvent);
      }
    }, 4_000);

    // Coming back to the tab refreshes at once rather than waiting out the
    // interval - a hidden tab polls nothing, so returning to one is exactly
    // when it is most stale.
    const onVisible = () => {
      if (document.visibilityState === "visible") void loadTimelineQuietly(openEvent);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
    // Paused while a question is in flight: the question is written to the
    // trail before the model is called, so a poll landing mid-request would
    // fetch it back and show it beside the copy already on screen.
  }, [openEvent, asking, loadTimelineQuietly]);

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

  /**
   * Ask the agent about the open case, and fold whatever it did back in.
   *
   * The reply, the row and the timeline all move together: an instruction
   * that sent a message has changed all three, and refreshing them
   * separately would show the confirmation before the message it confirms.
   */
  const askAgent = useCallback(
    async (question: string) => {
      if (!openEvent) return;
      const at = new Date().toISOString();
      setChats((c) => ({
        ...c,
        [openEvent]: [
          ...(c[openEvent] ?? []),
          { id: `q-${at}`, from: "you", text: question, at },
        ],
      }));
      setAsking(true);
      setLastResult(null);

      try {
        const res = await fetch(`/api/dashboard/${slug}/events/${openEvent}/ask`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question }),
        });
        const json = (await res.json()) as {
          reply?: string;
          action?: string;
          performed?: boolean;
          error?: string | null;
          sentBody?: string | null;
          row?: BoardRow;
        };

        // Kept locally only for what the stored turn cannot carry: the
        // confirmation of what was done, and the message that actually went
        // out. The words themselves come back with the timeline.
        setLastResult({
          action: json.action ?? null,
          performed: json.performed ?? false,
          error: json.error ?? null,
          sentBody: json.sentBody ?? null,
        });

        if (json.row) {
          const updated = json.row;
          setData((d) => ({
            ...d,
            rows: d.rows.map((r) => (r.event_id === updated.event_id ? updated : r)),
          }));
        }
        // Anything it actually did leaves a row in the audit trail, so the
        // story above the chat has to be re-read for the chat to make sense.
        // Quietly, and clearing the optimistic turn in the same commit as the
        // reload that replaces it. loadTimeline blanks the panel first, which
        // both lost the scroll position and left the local copy on screen
        // beside the stored one for a frame - the message appearing twice.
        setChats((c) => ({ ...c, [openEvent]: [] }));
        await loadTimelineQuietly(openEvent);
      } catch {
        setChats((c) => ({
          ...c,
          [openEvent]: [
            ...(c[openEvent] ?? []),
            {
              id: `a-${Date.now()}`,
              from: "agent",
              text: "I could not reach the server.",
              error: "Check your connection and ask again.",
              at: new Date().toISOString(),
            },
          ],
        }));
      } finally {
        setAsking(false);
      }
    },
    [slug, openEvent, setData, loadTimeline],
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
      {/* Fixed to the chat panel's own height (case-detail.tsx uses the same
          calc) only once that panel exists - otherwise the table is free to
          be as tall as its content, same as before. Matching heights without
          this cap left the "Showing X-Y of Z" footer sitting right after the
          last row instead of at the bottom whenever the panel was taller. */}
      <Card className={cn("min-w-0 gap-0 py-0", openRow && "lg:h-[calc(100vh-3rem)] lg:overflow-hidden")}>
        {/* status pill bar - "All cases" as the one filled pill, every other
            status as plain text with its own dot, coloured from the same
            STATUS_CLASS/DOT_CLASS map the badges and the detail panel use
            rather than a second palette invented just for this bar. */}
        <div className="border-b px-4 py-3 sm:px-6">
          {/* overflow-x-auto rather than flex-wrap: a narrower left column
              (chat panel open) used to wrap "Disputed" and "Written off" onto
              a second line, which then sat on top of the table below instead
              of pushing it down. One row that scrolls keeps the layout
              beneath it stable at any column width. */}
          <Tabs
            value={tab}
            onValueChange={(v) => { setTab(v as BoardStatus | "all"); setStatusFilter("all"); }}
            className="overflow-x-auto"
          >
            <TabsList className="h-auto flex-nowrap gap-1 bg-transparent p-0">
              <TabsTrigger
                value="all"
                className="shrink-0 gap-1.5 rounded-full border-none bg-transparent px-3 font-semibold text-muted-foreground data-active:bg-violet-600 data-active:text-white data-active:shadow-none"
              >
                All cases
                <span className="ml-0.5 tabular-nums opacity-80">{counts.all}</span>
              </TabsTrigger>
              {BOARD_STATUSES.map((s) => (
                <TabsTrigger
                  key={s}
                  value={s}
                  className={cn(
                    "shrink-0 gap-1.5 rounded-full border-none bg-transparent px-3 text-muted-foreground data-active:shadow-none",
                    TAB_ACTIVE_CLASS[STATUS_META[s].token],
                  )}
                >
                  <span
                    className={cn("size-1.5 rounded-full", DOT_CLASS[STATUS_META[s].token])}
                    aria-hidden="true"
                  />
                  {STATUS_META[s].label}
                  <span className="ml-0.5 tabular-nums opacity-80">{counts[s] ?? 0}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>

        {/* filters */}
        <div className="flex flex-wrap items-center gap-2 border-b p-4 sm:px-6">
          <div className="relative min-w-[220px] flex-1">
            <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by customer name, email, phone or case ID"
              aria-label="Search customers"
              className="w-full rounded-full pl-9"
            />
          </div>
          <Select value={channelFilter} onValueChange={(v) => setChannelFilter(v ?? "all")}>
            <SelectTrigger className="w-[150px] rounded-full">
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
          <Select value={reasonFilter} onValueChange={(v) => setReasonFilter(v ?? "all")}>
            <SelectTrigger className="w-[150px] rounded-full">
              <SelectValue placeholder="All reasons" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All reasons</SelectItem>
              {reasonOptions.map(([reason, label]) => (
                <SelectItem key={reason} value={reason}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={statusFilter}
            onValueChange={(v) => { setStatusFilter(v ?? "all"); setTab("all"); }}
          >
            <SelectTrigger className="w-[150px] rounded-full">
              <SelectValue placeholder="All status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All status</SelectItem>
              {BOARD_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>{STATUS_META[s].label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            className="rounded-full text-muted-foreground font-normal"
            title="More filters coming soon"
          >
            More filters
          </Button>
          <Button
            variant="outline" size="icon" className="rounded-full"
            onClick={() => {
              setQuery("");
              setChannelFilter("all");
              setReasonFilter("all");
              setStatusFilter("all");
              setTab("all");
            }}
            aria-label="Clear all filters"
            title="Clear all filters"
          >
            <FilterIcon className="size-4" />
          </Button>
          <Button
            variant="outline" size="icon" className="rounded-full"
            aria-label="Display options"
            title="Display options"
          >
            <SlidersHorizontalIcon className="size-4" />
          </Button>
        </div>

        {visible.length === 0 ? (
          <p className="text-muted-foreground p-12 text-center text-sm">
            {data.rows.length === 0
              ? "No events in this window. The first failed payment on your Razorpay account appears here within a minute."
              : "Nothing matches these filters."}
          </p>
        ) : (
          <>
            <div className={cn(openRow && "lg:min-h-0 lg:flex-1 lg:overflow-y-auto")}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={allVisibleSelected}
                      onCheckedChange={toggleAllVisible}
                      aria-label="Select all cases on this page"
                    />
                  </TableHead>
                  <TableHead className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Customer</TableHead>
                  <TableHead className="text-right text-xs font-semibold tracking-wide text-muted-foreground uppercase">Amount</TableHead>
                  <TableHead className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Reason</TableHead>
                  <TableHead className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Channel</TableHead>
                  <TableHead className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Status</TableHead>
                  <TableHead className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Next action</TableHead>
                  <TableHead className="text-center text-xs font-semibold tracking-wide text-muted-foreground uppercase">Recovery chance</TableHead>
                  <TableHead className="text-right text-xs font-semibold tracking-wide text-muted-foreground uppercase">Action</TableHead>
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
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selected.has(row.event_id)}
                        onCheckedChange={() => toggleOne(row.event_id)}
                        aria-label={`Select ${row.customer_name ?? "this case"}`}
                      />
                    </TableCell>
                    <TableCell>
                      {/* Under the name rather than as two more columns: the
                          table is already nine wide, and these are read as
                          part of who the row is, not compared down a column.
                          They are this order's details, not the customer
                          record's latest - the same reason the name is. */}
                      <div className="flex items-center gap-2.5">
                        <Avatar className="size-8 shrink-0">
                          <AvatarFallback
                            className={cn("text-xs font-bold", avatarTone(row.customer_id ?? row.event_id))}
                          >
                            {initials(row.customer_name)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0">
                          <div className="font-medium">{row.customer_name ?? "Unknown"}</div>
                          {row.customer_email && (
                            <div className="text-muted-foreground truncate text-xs">{row.customer_email}</div>
                          )}
                          {row.customer_phone && (
                            <div className="text-muted-foreground truncate text-xs tabular-nums">
                              {row.customer_phone}
                            </div>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">
                      {formatINR(row.amount)}
                    </TableCell>
                    <TableCell>
                      {/* Coloured by workflow rather than a reason-specific
                          palette: a case's workflow already has a colour
                          (WorkflowBadge, worn on the detail panel), so this
                          reuses it instead of inventing a second one. */}
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-xs font-medium",
                          row.workflow ? WORKFLOW_CLASS[row.workflow] : "bg-muted text-muted-foreground",
                        )}
                        title={row.workflow ? undefined : "Promise to pay"}
                      >
                        {row.reason_label}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {/* The sequence, not just the endpoint: a case worked
                          over email and then WhatsApp showed only the second,
                          so the escalation itself was invisible here. */}
                      {row.channels_used.length > 0 ? (
                        <span className="flex items-center gap-1">
                          {row.channels_used.map((c, i) => (
                            <span key={`${c}-${i}`} className="flex items-center gap-1">
                              {i > 0 && (
                                <ChevronRightIcon
                                  className="text-muted-foreground/50 size-3"
                                  aria-hidden="true"
                                />
                              )}
                              <ChannelMark channel={c} size={16} />
                            </span>
                          ))}
                        </span>
                      ) : (
                        <ChannelMark channel={null} />
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <StatusBadge status={row.status} variant="plain" />
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
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      {/* Read off the row rather than a separate field, so it
                          can never say something the schedule disagrees with -
                          see nextActionFor. */}
                      {(() => {
                        const next = nextActionFor(row);
                        return (
                          <div className="min-w-[104px]">
                            <div className="text-sm font-medium">{next.label}</div>
                            {next.when && (
                              <div className="text-muted-foreground text-xs tabular-nums">
                                {shortTime(next.when)}
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-center">
                        <RecoveryRing value={recoveryChance(row)} />
                      </div>
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
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t p-4 sm:px-6">
              <span className="text-muted-foreground text-sm tabular-nums">
                Showing {from}–{to} of {filtered.length} cases
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline" size="icon" className="rounded-lg" disabled={safePage <= 1}
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
                        size="icon"
                        className={cn(
                          "rounded-lg tabular-nums",
                          n === safePage && "bg-violet-600 text-white hover:bg-violet-600/90",
                        )}
                        onClick={() => setPage(n)}
                      >
                        {n}
                      </Button>
                    </span>
                  ))}
                <Button
                  variant="outline" size="icon" className="rounded-lg" disabled={safePage >= pages}
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
            chat={chats[openRow.event_id] ?? []}
            asking={asking}
            onAsk={askAgent}
            lastResult={lastResult}
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
