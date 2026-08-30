"use client";

/**
 * The Overview: the whole merchant dashboard on one page.
 *
 * Server-rendered once with real figures, then kept current by the SSE stream
 * in /api/dashboard/[slug]/stream. Filtering, searching and paging are local
 * to the browser: the rows are already here, so narrowing them is a render
 * rather than a request.
 */
import { useEffect, useMemo, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Label,
  Line,
  LineChart,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts";
import {
  IndianRupeeIcon,
  WorkflowIcon,
  TriangleAlertIcon,
  SendIcon,
  ShieldCheckIcon,
  TrendingUpIcon,
  TrendingDownIcon,
  DownloadIcon,
  SearchIcon,
  CalendarIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  XIcon,
  CheckIcon,
  CheckCheckIcon,
  Volume2Icon,
  BanIcon,
  RotateCcwIcon,
  CreditCardIcon,
  InfoIcon,
  UserIcon,
  ArrowLeftIcon,
  MailIcon,
  MailCheckIcon,
  MailWarningIcon,
  PhoneCallIcon,
  CircleCheckIcon,
  EllipsisVerticalIcon,
  PauseIcon,
  PlayIcon,
  FlagIcon,
  CalendarClockIcon,
  FastForwardIcon,
  ArchiveIcon,
  Undo2Icon,
  UserCogIcon,
} from "lucide-react";

import { formatINR, type AdminActionId } from "@/lib/types";
import {
  BOARD_STATUSES,
  STATUS_META,
  RANGES,
  formatDuration,
  delta,
  INBOUND_PREFIX,
  REPLY_PREFIX,
  SUMMARY_PREFIX,
  type Dashboard,
  type BoardRow,
  type BoardStatus,
  type TimelineEntry,
} from "@/lib/board";
import {
  ADMIN_ACTIONS,
  availableAdminActions,
  hasPendingStep,
  type AdminActionDef,
} from "@/lib/admin-actions";
import {
  WORKFLOWS,
  WORKFLOW_IDS,
  WORKFLOW_COUNT,
  type WorkflowId,
} from "@/lib/workflows";
import { cn } from "@/lib/utils";
import { useSidebar } from "@/components/ui/sidebar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";

const PAGE_SIZE = 8;

/* ── status → shadcn badge treatment ─────────────────────────────────────── */

const STATUS_CLASS: Record<string, string> = {
  recovered:
    "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-400 dark:border-emerald-900",
  chasing:
    "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/50 dark:text-amber-400 dark:border-amber-900",
  voice:
    "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/50 dark:text-blue-400 dark:border-blue-900",
  human:
    "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/50 dark:text-red-400 dark:border-red-900",
  stopped:
    "bg-muted text-muted-foreground border-border",
  disputed:
    "bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/50 dark:text-purple-400 dark:border-purple-900",
  written_off:
    "bg-slate-100 text-slate-600 border-slate-300 dark:bg-slate-900/50 dark:text-slate-400 dark:border-slate-800",
};

const DOT_CLASS: Record<string, string> = {
  recovered: "bg-emerald-500",
  chasing: "bg-amber-500",
  voice: "bg-blue-500",
  human: "bg-red-500",
  stopped: "bg-muted-foreground/60",
  disputed: "bg-purple-500",
  written_off: "bg-slate-400",
};

function initials(name: string | null): string {
  if (!name?.trim()) return "?";
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric", month: "short", year: "numeric",
  });
}

function shortTime(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

/** Rupees, abbreviated the Indian way, for an axis where space is scarce. */
function compactINR(paise: number): string {
  const r = paise / 100;
  if (r >= 1e7) return `₹${(r / 1e7).toFixed(r % 1e7 === 0 ? 0 : 1)}Cr`;
  if (r >= 1e5) return `₹${(r / 1e5).toFixed(r % 1e5 === 0 ? 0 : 1)}L`;
  if (r >= 1e3) return `₹${(r / 1e3).toFixed(r % 1e3 === 0 ? 0 : 1)}K`;
  return `₹${Math.round(r)}`;
}

/**
 * The channel a customer was reached on, as the service's own mark.
 *
 * The brand logos are more legible at this size than a generic envelope or
 * handset would be - people recognise them without reading, which is the whole
 * job of a column you scan rather than read. So no text label: the mark alone
 * carries it, and `title` plus `alt` keep it available to a screen reader and
 * on hover.
 */
const CHANNEL_ICON: Record<string, { src: string; label: string }> = {
  email: { src: "/icons/email.png", label: "Email" },
  whatsapp: { src: "/icons/whatsapp.png", label: "WhatsApp" },
  voice: { src: "/icons/voice.png", label: "Call" },
};

function ChannelMark({ channel, size = 18 }: { channel: string | null; size?: number }) {
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

function StatusBadge({ status }: { status: BoardStatus }) {
  const meta = STATUS_META[status];
  return (
    <Badge variant="outline" className={cn("gap-1.5 font-medium", STATUS_CLASS[meta.token])}>
      <span className={cn("size-1.5 rounded-full", DOT_CLASS[meta.token])} aria-hidden="true" />
      {meta.label}
    </Badge>
  );
}

function DeltaText({ value, riseIsGood = true }: { value: number | null; riseIsGood?: boolean }) {
  // No previous period is not a change of zero - "0%" would claim a
  // comparison that was never made.
  if (value === null) {
    return <span className="text-muted-foreground text-xs">no prior period</span>;
  }
  if (value === 0) return <span className="text-muted-foreground text-xs">no change</span>;
  const good = value > 0 === riseIsGood;
  const Icon = value > 0 ? TrendingUpIcon : TrendingDownIcon;
  return (
    <span
      className={cn(
        "flex items-center gap-1 text-xs font-semibold",
        good ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400",
      )}
    >
      <Icon className="size-3.5" />
      {Math.abs(value)}%
    </span>
  );
}

/* ── metric card ─────────────────────────────────────────────────────────── */

const SPARK_CONFIG = { v: { label: "value" } } satisfies ChartConfig;

function MetricCard({
  icon, label, value, sub, deltaValue, riseIsGood = true, spark, colour,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  /** A short explanatory line. Plain text or a composed line - never a paragraph. */
  sub?: React.ReactNode;
  /** Omit entirely to hide the trend row - not every card has a meaningful one. */
  deltaValue?: number | null;
  riseIsGood?: boolean;
  spark: number[];
  colour: string;
}) {
  const data = spark.map((v, i) => ({ i, v }));
  const id = label.replace(/\W/g, "");

  return (
    <Card className="gap-0 overflow-hidden pb-0">
      <CardHeader className="flex items-center gap-2">
        <div
          className="flex size-8 shrink-0 items-center justify-center rounded-sm"
          style={{ background: `color-mix(in oklab, ${colour} 12%, transparent)`, color: colour }}
        >
          {icon}
        </div>
        <span className="text-2xl font-semibold tracking-tight tabular-nums">{value}</span>
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5 pb-4">
        <span className="text-sm font-semibold">{label}</span>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {deltaValue !== undefined && <DeltaText value={deltaValue} riseIsGood={riseIsGood} />}
          {sub && <span className="text-muted-foreground text-xs">{sub}</span>}
        </div>
      </CardContent>
      {/* Shape only - the number above carries the value, so no axes. Gradient
          stops match shadcn's own gradient-area example (5%/95% at .8/.1),
          so the fill reads the same way every other gradient chart in this
          library does. */}
      <ChartContainer config={SPARK_CONFIG} className="h-[46px] w-full">
        <AreaChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={`sp-${id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={colour} stopOpacity={0.8} />
              <stop offset="95%" stopColor={colour} stopOpacity={0.1} />
            </linearGradient>
          </defs>
          <Area
            dataKey="v"
            type="natural"
            stroke={colour}
            strokeWidth={1.8}
            fill={`url(#sp-${id})`}
            fillOpacity={0.4}
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </ChartContainer>
    </Card>
  );
}

/* ── workflows ───────────────────────────────────────────────────────────── */

/**
 * A short name for the table column, where the full label does not fit.
 * The pills and the settings screen carry the full one.
 */
const WORKFLOW_SHORT: Record<WorkflowId, string> = {
  checkout_abandonment: "Checkout",
  failed_payment: "Failed payment",
  subscription_autopay: "Subscription",
  overdue_invoice: "Overdue invoice",
};

const WORKFLOW_CLASS: Record<WorkflowId, string> = {
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
function WorkflowBadge({ workflow }: { workflow: WorkflowId | null }) {
  if (!workflow) {
    return (
      <Badge variant="secondary" className="text-xs" title="Raised from a promise the customer made in conversation. Runs whatever the workflow settings say.">
        Promise to pay
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className={cn("text-xs", WORKFLOW_CLASS[workflow])}
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
function WorkflowPills({ enabled, slug }: { enabled: WorkflowId[]; slug: string }) {
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

/* ── admin overrides: the kebab menu and its dialog ─────────────────────────── */

const ADMIN_ACTION_ICON: Record<AdminActionId, React.ComponentType<{ className?: string }>> = {
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

/** The kebab menu on a customer row - only the actions valid for its current status. */
function RowActionsMenu({
  row, onOpenAction,
}: {
  row: BoardRow;
  onOpenAction: (action: AdminActionDef) => void;
}) {
  const actions = availableAdminActions({
    status: row.status,
    paused: row.paused,
    hasPendingStep: hasPendingStep(row),
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Actions for ${row.customer_name ?? "this customer"}`}
            onClick={(e) => e.stopPropagation()}
          >
            <EllipsisVerticalIcon className="size-4" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        {actions.length === 0 ? (
          <DropdownMenuItem disabled>No actions available</DropdownMenuItem>
        ) : (
          actions.map((action) => {
            const Icon = ADMIN_ACTION_ICON[action.id];
            return (
              <DropdownMenuItem
                key={action.id}
                variant={action.destructive ? "destructive" : "default"}
                onClick={() => onOpenAction(action)}
              >
                <Icon className="size-4" />
                {action.label}
              </DropdownMenuItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Local, unsubmitted state for whichever admin-action dialog is open. */
interface OverrideFormState {
  note: string;
  choice: string;
  otherText: string;
  date: string;
}

const EMPTY_OVERRIDE_FORM: OverrideFormState = { note: "", choice: "", otherText: "", date: "" };

/** Resolves the form into the one string the API wants, or an error to show instead of submitting. */
function resolveOverridePayload(
  action: AdminActionDef,
  form: OverrideFormState,
): { reasonText: string | null; snoozeUntil: string | null } | { error: string } {
  switch (action.input.kind) {
    case "none":
      return { reasonText: null, snoozeUntil: null };
    case "note":
      if (action.input.required && !form.note.trim()) return { error: "This needs a reason first." };
      return { reasonText: form.note.trim() || null, snoozeUntil: null };
    case "choice": {
      if (!form.choice) return { error: "Pick a reason first." };
      if (form.choice === "Other" && !form.otherText.trim()) {
        return { error: "Say what \"Other\" means here." };
      }
      const reasonText = form.choice === "Other" ? `Other: ${form.otherText.trim()}` : form.choice;
      return { reasonText, snoozeUntil: null };
    }
    case "date": {
      if (!form.date) return { error: "Pick a date first." };
      const snoozeUntil = `${form.date}T09:00:00Z`;
      if (Date.parse(snoozeUntil) <= Date.now()) return { error: "Pick a date in the future." };
      return { reasonText: form.note.trim() || null, snoozeUntil };
    }
  }
}

/** The reason/note/date collector for one admin action - also opt-out's confirm step. */
function AdminActionDialog({
  row, action, onClose, onSubmit,
}: {
  row: BoardRow;
  action: AdminActionDef;
  onClose: () => void;
  onSubmit: (payload: { reasonText: string | null; snoozeUntil: string | null }) => Promise<string | null>;
}) {
  const [form, setForm] = useState<OverrideFormState>(EMPTY_OVERRIDE_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const todayStr = new Date().toISOString().slice(0, 10);

  const handleSubmit = useCallback(async () => {
    const resolved = resolveOverridePayload(action, form);
    if ("error" in resolved) { setError(resolved.error); return; }
    setSubmitting(true);
    setError(null);
    const failure = await onSubmit(resolved);
    setSubmitting(false);
    if (failure) setError(failure);
    else onClose();
  }, [action, form, onSubmit, onClose]);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{action.label}</DialogTitle>
          <DialogDescription>
            {action.description} This applies to <strong>{row.customer_name ?? "this customer"}</strong>'s{" "}
            {formatINR(row.amount)} case.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {action.confirm && (
            <p className="rounded-md border border-amber-200 bg-amber-50 p-2.5 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
              This is permanent and cannot be undone from here - the customer will not be contacted again on any channel.
            </p>
          )}

          {action.input.kind === "note" && (
            <Textarea
              value={form.note}
              onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
              placeholder={action.input.placeholder}
              rows={3}
              autoFocus
            />
          )}

          {action.input.kind === "choice" && (
            <>
              <Select value={form.choice} onValueChange={(v) => setForm((f) => ({ ...f, choice: v ?? "" }))}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Pick a reason" /></SelectTrigger>
                <SelectContent>
                  {action.input.choices.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  <SelectItem value="Other">Other</SelectItem>
                </SelectContent>
              </Select>
              {form.choice === "Other" && (
                <Textarea
                  value={form.otherText}
                  onChange={(e) => setForm((f) => ({ ...f, otherText: e.target.value }))}
                  placeholder={action.input.placeholder}
                  rows={2}
                  autoFocus
                />
              )}
            </>
          )}

          {action.input.kind === "date" && (
            <>
              <Input
                type="date"
                min={todayStr}
                value={form.date}
                onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
              />
              <Textarea
                value={form.note}
                onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
                placeholder="Note (optional)"
                rows={2}
              />
            </>
          )}

          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button
            variant={action.destructive ? "destructive" : "default"}
            onClick={() => void handleSubmit()}
            disabled={submitting}
          >
            {submitting ? "Working…" : action.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── the page ────────────────────────────────────────────────────────────── */

const CAUSE_COLOURS = [
  "var(--chart-1)", "var(--chart-2)", "var(--chart-3)",
  "var(--chart-4)", "var(--chart-5)",
];

export function Overview({ slug, initial }: { slug: string; initial: Dashboard }) {
  const router = useRouter();
  const [data, setData] = useState<Dashboard>(initial);
  const [tab, setTab] = useState<BoardStatus | "all">("all");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [channelFilter, setChannelFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [openEvent, setOpenEvent] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[] | null>(null);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [overrideTarget, setOverrideTarget] = useState<{ row: BoardRow; action: AdminActionDef } | null>(null);
  const { isMobile, setOpen: setSidebarOpen } = useSidebar();

  useEffect(() => setData(initial), [initial]);

  // The nav rail and the detail panel are both competing for width, so the
  // rail collapses to icons for as long as the panel is open - on mobile the
  // rail is already off-canvas and never competes for space, so it is left
  // alone there.
  useEffect(() => {
    if (isMobile) return;
    setSidebarOpen(!openEvent);
  }, [openEvent, isMobile, setSidebarOpen]);

  useEffect(() => {
    const source = new EventSource(`/api/dashboard/${slug}/stream?days=${initial.days}`);
    source.addEventListener("board", (e) => {
      try {
        setData(JSON.parse((e as MessageEvent).data) as Dashboard);
        setLive(true);
      } catch {
        // A truncated frame; the next push carries the same state.
      }
    });
    // Dropping is normal: the server closes the stream just short of the
    // platform's function limit and EventSource reconnects by itself.
    source.onerror = () => setLive(false);
    return () => source.close();
  }, [slug, initial.days]);

  const m = data.metrics;
  const p = data.previous;

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
    [slug, openEvent, loadTimeline],
  );

  const compliance = m.sent_total === 0 ? null : Math.round((m.sent_in_window / m.sent_total) * 100);
  // How many of the enabled workflows actually saw a case in this window.
  // The headline number is what the merchant switched on; this is what
  // actually happened, which is usually the smaller and more interesting one.
  const activeWorkflows = new Set(
    data.rows.map((r) => r.workflow).filter((w) => w !== null),
  ).size;
  const prevCompliance = p.sent_total === 0 ? null : Math.round((p.sent_in_window / p.sent_total) * 100);

  const exportCsv = useCallback(() => {
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines: string[] = [
      `Tally export,${new Date().toISOString()}`,
      `Range,Last ${data.days} days,${data.from},${data.to}`,
      "",
      "Summary,Value",
      `Revenue recovered,${m.amount_recovered / 100}`,
      `Recoveries,${m.recovered_count}`,
      `Recovery rate %,${m.recovery_rate}`,
      `Revenue at risk,${m.amount_at_risk / 100}`,
      `Interventions sent,${m.sent_total}`,
      `Compliance %,${compliance ?? ""}`,
      `Needs a human,${m.needs_human}`,
      `Promise-to-pay active,${m.promise_active}`,
      `Escalated to voice,${m.escalated_voice}`,
      `Stopped,${m.stopped}`,
      "",
      "Workflow,Enabled",
      ...WORKFLOW_IDS.map(
        (id) => `${esc(WORKFLOWS[id].label)},${data.workflows_enabled.includes(id) ? "yes" : "no"}`,
      ),
      "",
      "Customer,Amount,Workflow,Reason,Channel,Status,Attempts,Failed on",
      ...filtered.map((r) =>
        [
          esc(r.customer_name ?? "Unknown"),
          r.amount === null ? "" : r.amount / 100,
          esc(r.workflow ? WORKFLOWS[r.workflow].label : "Promise to pay"),
          esc(r.reason_label),
          esc(r.last_channel ?? ""),
          esc(STATUS_META[r.status].label),
          `${r.attempts}/${r.max_attempts}`,
          r.failed_on.slice(0, 10),
        ].join(","),
      ),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tally-${slug}-${data.days}d-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filtered, m, compliance, data.days, data.from, data.to, data.workflows_enabled, slug]);

  const spark = {
    recovered: data.series.map((d) => d.amount_recovered),
    rate: data.series.map((d) => (d.events === 0 ? 0 : (d.recovered / d.events) * 100)),
    risk: data.series.map((d) => d.amount_at_risk),
    sent: data.series.map((d) => d.sent),
    compliance: data.series.map((d) => (d.sent === 0 ? 0 : (d.sent_in_window / d.sent) * 100)),
  };

  const lineData = data.series.map((d) => ({
    day: new Date(`${d.day}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" }),
    recovered: d.amount_recovered,
  }));

  const donutData = m.top_causes.map((c, i) => ({
    name: c.label,
    value: data.rows.filter((r) => r.reason === c.reason).reduce((s, r) => s + (r.amount ?? 0), 0),
    count: c.count,
    fill: CAUSE_COLOURS[i % CAUSE_COLOURS.length],
  }));
  const donutTotal = donutData.reduce((s, d) => s + d.value, 0);

  const lineConfig = {
    recovered: { label: "Recovered", color: "var(--chart-2)" },
  } satisfies ChartConfig;

  return (
    <div className="flex flex-col gap-6">
      {/* ── top bar ── */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Overview</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Every recovery for this business, in one place
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "flex items-center gap-1.5 text-xs font-semibold tracking-wide uppercase",
              live ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
            )}
          >
            <span className={cn("size-1.5 rounded-full", live ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground/50")} />
            {live ? "Live" : "Reconnecting"}
          </span>
          <Select
            value={String(data.days)}
            onValueChange={(v) => router.push(`?range=${v ?? 7}`, { scroll: false })}
          >
            <SelectTrigger className="w-[168px]">
              <CalendarIcon className="size-4 opacity-70" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RANGES.map((d) => (
                <SelectItem key={d} value={String(d)}>Last {d} days</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={exportCsv}>
            <DownloadIcon className="size-4" />
            Export report
          </Button>
        </div>
      </div>

      {/* ── active workflows ── */}
      <WorkflowPills enabled={data.workflows_enabled} slug={slug} />

      {/* ── metric row ── */}
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <MetricCard
          icon={<IndianRupeeIcon className="size-4" />} colour="var(--chart-2)"
          label="Revenue recovered" value={formatINR(m.amount_recovered)}
          sub={
            <>
              of {formatINR(m.amount_total)} · <strong className="text-foreground">{m.recovery_rate}%</strong>
            </>
          }
          deltaValue={delta(m.amount_recovered, p.amount_recovered)} spark={spark.recovered}
        />
        <MetricCard
          icon={<WorkflowIcon className="size-4" />} colour="var(--chart-4)"
          label="Active workflows" value={String(data.workflows_enabled.length)}
          sub={`of ${WORKFLOW_COUNT} · ${activeWorkflows} seen in this window`}
          spark={spark.rate}
        />
        <MetricCard
          icon={<TriangleAlertIcon className="size-4" />} colour="var(--chart-5)"
          label="Revenue at risk" value={formatINR(m.amount_at_risk)} sub="still open"
          deltaValue={delta(m.amount_at_risk, p.amount_at_risk)} riseIsGood={false}
          spark={spark.risk}
        />
        <MetricCard
          icon={<SendIcon className="size-4" />} colour="var(--chart-1)"
          label="Interventions sent" value={String(m.sent_total)} sub="messages delivered"
          deltaValue={delta(m.sent_total, p.sent_total)} spark={spark.sent}
        />
        <MetricCard
          icon={<ShieldCheckIcon className="size-4" />} colour="var(--chart-3)"
          label="Compliance" value={compliance === null ? "—" : `${compliance}%`}
          sub={m.sent_total === 0 ? "nothing sent" : `${m.sent_in_window}/${m.sent_total} in-window`}
          deltaValue={compliance === null || prevCompliance === null ? null : delta(compliance, prevCompliance)}
          spark={spark.compliance}
        />
      </div>

      <p className="text-muted-foreground -mt-2 text-sm">
        {m.top_causes.length === 0 ? (
          "No open failures in this window."
        ) : (
          <>
            <span className="text-foreground font-semibold">Top causes:</span>{" "}
            {m.top_causes.map((c, i) => (
              <span key={c.reason}>
                {i > 0 && " · "}
                {c.label} ({c.count})
              </span>
            ))}
          </>
        )}
      </p>

      {/* ── charts ── */}
      <div className="grid gap-6 lg:grid-cols-2 xl:grid-cols-4">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Revenue recovered over time</CardTitle>
            <span className="text-muted-foreground text-xs">daily</span>
          </CardHeader>
          <CardContent>
            <ChartContainer config={lineConfig} className="h-[240px] w-full">
              <LineChart data={lineData} margin={{ left: 4, right: 12, top: 6 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={10} minTickGap={24} />
                <YAxis
                  tickLine={false} axisLine={false} tickMargin={6} width={54}
                  tickFormatter={(v: number) => (v === 0 ? "0" : compactINR(v))}
                />
                <ChartTooltip
                  content={<ChartTooltipContent formatter={(v) => formatINR(Number(v))} />}
                />
                <Line
                  dataKey="recovered" type="monotone"
                  stroke="var(--color-recovered)" strokeWidth={2}
                  dot={{ r: 3 }} activeDot={{ r: 5 }} isAnimationActive={false}
                />
              </LineChart>
            </ChartContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Recovery by cause</CardTitle></CardHeader>
          <CardContent>
            {donutData.length === 0 ? (
              <p className="text-muted-foreground py-10 text-center text-sm">
                Nothing in this window.
              </p>
            ) : (
              <>
                <ChartContainer config={{}} className="mx-auto h-[180px] w-full">
                  <PieChart>
                    <ChartTooltip
                      content={<ChartTooltipContent hideLabel formatter={(v) => formatINR(Number(v))} />}
                    />
                    <Pie data={donutData} dataKey="value" nameKey="name" innerRadius={52} outerRadius={78} paddingAngle={2} isAnimationActive={false}>
                      {donutData.map((d) => <Cell key={d.name} fill={d.fill} />)}
                      <Label
                        content={({ viewBox }) => {
                          if (!viewBox || !("cx" in viewBox)) return null;
                          return (
                            <text x={viewBox.cx} y={viewBox.cy} textAnchor="middle">
                              <tspan x={viewBox.cx} y={(viewBox.cy ?? 0) - 4} className="fill-foreground text-sm font-bold">
                                {formatINR(donutTotal)}
                              </tspan>
                              <tspan x={viewBox.cx} y={(viewBox.cy ?? 0) + 13} className="fill-muted-foreground text-xs">
                                at stake
                              </tspan>
                            </text>
                          );
                        }}
                      />
                    </Pie>
                  </PieChart>
                </ChartContainer>
                <ul className="mt-3 space-y-1.5 text-sm">
                  {donutData.map((d) => (
                    <li key={d.name} className="flex items-center gap-2">
                      <span className="size-2 shrink-0 rounded-full" style={{ background: d.fill }} />
                      <span className="text-muted-foreground truncate">{d.name}</span>
                      <span className="ml-auto font-semibold tabular-nums">{formatINR(d.value)}</span>
                      <span className="text-muted-foreground text-xs tabular-nums">
                        ({donutTotal === 0 ? 0 : Math.round((d.value / donutTotal) * 100)}%)
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recovery rate by channel</CardTitle>
            <span className="text-muted-foreground text-xs">of events reached</span>
          </CardHeader>
          <CardContent className="space-y-5">
            {[...data.channels]
              .sort((a, b) => b.rate - a.rate || b.reached - a.reached)
              .map((c) => (
                <div key={c.channel} className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <ChannelMark channel={c.channel} size={22} />
                    <span className="text-sm font-bold tabular-nums">{c.rate}%</span>
                  </div>
                  <div className="bg-muted h-1.5 overflow-hidden rounded-full">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        c.channel === "whatsapp" ? "bg-emerald-500"
                          : c.channel === "voice" ? "bg-amber-500" : "bg-blue-500",
                      )}
                      style={{ width: `${Math.max(c.rate, c.rate > 0 ? 4 : 0)}%` }}
                    />
                  </div>
                  <p className="text-muted-foreground text-xs tabular-nums">
                    {c.sent} sent · {c.reached} reached · {c.recovered} recovered
                  </p>
                </div>
              ))}
          </CardContent>
        </Card>
      </div>

      {/* ── status cards ── */}
      <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
        {[
          {
            label: "Needs a human", value: m.needs_human,
            sub: "risk flags and repeat failures", tone: "human",
            icon: <TriangleAlertIcon className="size-4" />, colour: "var(--destructive)",
          },
          {
            label: "Promise-to-pay active", value: m.promise_active,
            sub: "awaiting a promised date", tone: "voice",
            icon: <SendIcon className="size-4" />, colour: "var(--chart-4)",
          },
          {
            label: "Escalated to voice", value: m.escalated_voice,
            sub: "a call was placed", tone: "chasing",
            icon: <ShieldCheckIcon className="size-4" />, colour: "var(--chart-1)",
          },
          {
            label: "Stopped", value: m.stopped,
            sub: "capped or opted out", tone: "stopped",
            icon: <XIcon className="size-4" />, colour: "var(--muted-foreground)",
          },
        ].map((s) => (
          <Card
            key={s.label}
            size="sm"
            className="gap-0 border"
            style={{
              background: `color-mix(in oklab, ${s.colour} 7%, var(--card))`,
              borderColor: `color-mix(in oklab, ${s.colour} 22%, var(--border))`,
            }}
          >
            <CardContent className="flex items-center gap-3 py-1">
              <div
                className="flex size-8 shrink-0 items-center justify-center rounded-md"
                style={{ background: `color-mix(in oklab, ${s.colour} 16%, transparent)`, color: s.colour }}
              >
                {s.icon}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className={cn("size-1.5 rounded-full", DOT_CLASS[s.tone])} aria-hidden="true" />
                  <span className="text-muted-foreground truncate text-xs font-semibold">{s.label}</span>
                </div>
                <div className="text-xl font-bold tracking-tight tabular-nums">{s.value}</div>
              </div>
            </CardContent>
            <p className="text-muted-foreground px-3 pb-2.5 text-xs">{s.sub}</p>
          </Card>
        ))}
      </div>

      {/* ── table + detail panel ── */}
      <div className="flex flex-col items-start gap-6 lg:flex-row">
      <Card className="min-w-0 flex-1 gap-0 py-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4 sm:p-6">
          <CardTitle>Recoveries</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
              <Input
                value={query} onChange={(e) => setQuery(e.target.value)}
                placeholder="Search customer, cause or amount"
                aria-label="Search recoveries"
                className="w-[260px] pl-9"
              />
            </div>
            <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v ?? "all"); setTab("all"); }}>
              <SelectTrigger className="w-[152px]"><SelectValue placeholder="All status" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All status</SelectItem>
                {BOARD_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>{STATUS_META[s].label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={channelFilter} onValueChange={(v) => setChannelFilter(v ?? "all")}>
              <SelectTrigger className="w-[152px]"><SelectValue placeholder="All channels" /></SelectTrigger>
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
          <Tabs value={tab} onValueChange={(v) => { setTab(v as BoardStatus | "all"); setStatusFilter("all"); }}>
            <TabsList className="h-auto flex-wrap">
              <TabsTrigger value="all">
                All customers
                <span className="text-muted-foreground ml-1.5 tabular-nums">{counts.all}</span>
              </TabsTrigger>
              {BOARD_STATUSES.map((s) => (
                <TabsTrigger key={s} value={s}>
                  <span className={cn("size-1.5 rounded-full", DOT_CLASS[STATUS_META[s].token])} aria-hidden="true" />
                  {STATUS_META[s].label}
                  <span className="text-muted-foreground ml-1 tabular-nums">{counts[s] ?? 0}</span>
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
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((row) => (
                  <TableRow
                    key={row.event_id}
                    onClick={() => void toggleRow(row.event_id)}
                    tabIndex={0} role="button"
                    aria-expanded={openEvent === row.event_id}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void toggleRow(row.event_id); }
                    }}
                    className={cn("cursor-pointer", openEvent === row.event_id && "bg-muted/60")}
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
                        {row.paused && (
                          <Badge variant="outline" className="gap-1 text-xs">
                            <PauseIcon className="size-3" />Paused
                          </Badge>
                        )}
                        {!row.paused && row.hold_until && Date.parse(row.hold_until) > Date.now() && (
                          <Badge variant="outline" className="gap-1 text-xs">
                            <CalendarClockIcon className="size-3" />Snoozed
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
                    <TableCell className="text-muted-foreground whitespace-nowrap text-sm">
                      {shortDate(row.failed_on)}
                    </TableCell>
                    <TableCell className="text-right">
                      <RowActionsMenu row={row} onOpenAction={(action) => setOverrideTarget({ row, action })} />
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
                <Button variant="outline" size="icon" disabled={safePage <= 1}
                        onClick={() => setPage(safePage - 1)} aria-label="Previous page">
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
                <Button variant="outline" size="icon" disabled={safePage >= pages}
                        onClick={() => setPage(safePage + 1)} aria-label="Next page">
                  <ChevronRightIcon className="size-4" />
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>

      {openRow && (
        <div className="w-full shrink-0 lg:sticky lg:top-6 lg:h-[calc(100vh-7.5rem)] lg:w-[400px] xl:w-[440px]">
          <DetailPanel row={openRow} entries={timeline} error={timelineError}
                       onClose={() => setOpenEvent(null)} />
        </div>
      )}
      </div>

      {overrideTarget && (
        <AdminActionDialog
          row={overrideTarget.row}
          action={overrideTarget.action}
          onClose={() => setOverrideTarget(null)}
          onSubmit={(payload) => submitOverride(overrideTarget.row, overrideTarget.action, payload)}
        />
      )}
    </div>
  );
}

/* ── attempt cards ───────────────────────────────────────────────────────── */

/**
 * A row's `outcome` as the merchant should read it, not as the enum spells
 * it - "sent" and "delivered" are both a success as far as anyone here can
 * tell, since neither channel gives us an open/read receipt to draw a finer
 * line with.
 */
const OUTCOME_META: Record<string, { label: string; tone: "good" | "bad" | "muted" }> = {
  sent: { label: "Sent", tone: "good" },
  delivered: { label: "Delivered", tone: "good" },
  failed: { label: "Failed", tone: "bad" },
  escalated: { label: "Escalated", tone: "bad" },
  skipped: { label: "Skipped", tone: "muted" },
  no_action: { label: "No action taken", tone: "muted" },
  pending: { label: "Pending", tone: "muted" },
};

const PILL_TONE_CLASS: Record<string, string> = {
  good: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-900",
  bad: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-400 dark:border-red-900",
  muted: "bg-muted text-muted-foreground border-border",
};

function outcomeMeta(outcome: string) {
  return OUTCOME_META[outcome] ?? { label: outcome.replace(/_/g, " "), tone: "muted" as const };
}

function GuardrailBadge({ guardrail }: { guardrail: string | null }) {
  if (!guardrail) return null;
  return <Badge variant="secondary" className="text-xs">{guardrail.replace(/_/g, " ")}</Badge>;
}

/** A rounded, iconed chip for an outcome - "Opened, no reply" rather than a bare uppercase word. */
function OutcomePill({
  icon: Icon, label, tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  tone: "good" | "bad" | "muted";
}) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold", PILL_TONE_CLASS[tone])}>
      <Icon className="size-3.5" />
      {label}
    </span>
  );
}

const EMAIL_OUTCOME_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  sent: MailCheckIcon, delivered: MailCheckIcon, failed: MailWarningIcon,
};

function EmailAttemptCard({ entry }: { entry: TimelineEntry }) {
  const meta = outcomeMeta(entry.outcome);
  return (
    <div className="rounded-xl border p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Image src="/icons/email.png" alt="Email" width={18} height={18} className="rounded-[4px]" unoptimized />
          <span className="text-sm font-semibold">Email</span>
        </div>
        <OutcomePill icon={EMAIL_OUTCOME_ICON[entry.outcome] ?? MailIcon} label={meta.label} tone={meta.tone} />
      </div>
      <div className="text-muted-foreground mt-2 flex flex-wrap items-center gap-2 text-xs tabular-nums">
        {shortTime(entry.created_at)}
        <GuardrailBadge guardrail={entry.guardrail} />
        {entry.in_window === false && (
          <Badge variant="outline" className={cn("text-xs", STATUS_CLASS.chasing)}>outside window</Badge>
        )}
      </div>
      {entry.rationale && <p className="text-muted-foreground mt-2 text-sm">{entry.rationale}</p>}
      {entry.message && (
        <div className="bg-muted/50 mt-3 rounded-md border p-3 text-sm whitespace-pre-wrap">
          {entry.message}
        </div>
      )}
    </div>
  );
}

function VoiceAttemptCard({ entry }: { entry: TimelineEntry }) {
  const meta = outcomeMeta(entry.outcome);
  return (
    <div className="rounded-xl border p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Image src="/icons/voice.png" alt="Call" width={18} height={18} className="rounded-[4px]" unoptimized />
          <span className="text-sm font-semibold">Voice call</span>
        </div>
        <OutcomePill icon={PhoneCallIcon} label={meta.label} tone={meta.tone} />
      </div>
      <div className="text-muted-foreground mt-2 flex flex-wrap items-center gap-2 text-xs tabular-nums">
        {shortTime(entry.created_at)}
        <GuardrailBadge guardrail={entry.guardrail} />
      </div>
      {entry.rationale && <p className="text-muted-foreground mt-2 text-sm">{entry.rationale}</p>}
      {entry.message && (
        <div className="text-muted-foreground mt-3 flex items-start gap-2 rounded-md border border-dashed p-3 text-sm">
          <Volume2Icon className="mt-0.5 size-4 shrink-0 opacity-70" aria-hidden="true" />
          <span className="whitespace-pre-wrap">{entry.message}</span>
        </div>
      )}
    </div>
  );
}

/** A single tick, two ticks, or a failure mark - never a read receipt Twilio never gave us. */
function WhatsAppTicks({ outcome }: { outcome: string }) {
  if (outcome === "failed") {
    return <TriangleAlertIcon className="text-destructive size-3.5 shrink-0" aria-label="Not delivered" />;
  }
  if (outcome === "delivered") {
    return <CheckCheckIcon className="text-muted-foreground size-3.5 shrink-0" aria-label="Delivered" />;
  }
  if (outcome === "sent") {
    return <CheckIcon className="text-muted-foreground size-3.5 shrink-0" aria-label="Sent" />;
  }
  return null;
}

/** One message inside the conversation - a bubble, not a card of its own. */
function WhatsAppBubble({ entry }: { entry: TimelineEntry }) {
  const raw = entry.message ?? "";
  const inbound = raw.startsWith(INBOUND_PREFIX);
  const text = inbound
    ? raw.slice(INBOUND_PREFIX.length)
    : raw.startsWith(REPLY_PREFIX)
      ? raw.slice(REPLY_PREFIX.length)
      : raw;
  if (!text) return null;

  return (
    <div className={cn("flex", inbound ? "justify-start" : "justify-end")}>
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap",
          inbound
            ? "bg-background border rounded-bl-sm"
            : "bg-emerald-100 rounded-br-sm dark:bg-emerald-950/50",
        )}
      >
        {text}
        <span className="text-muted-foreground mt-1 flex items-center justify-end gap-1 text-[0.65rem] tabular-nums">
          {shortTime(entry.created_at).split(", ").pop()}
          {!inbound && <WhatsAppTicks outcome={entry.outcome} />}
        </span>
      </div>
    </div>
  );
}

/** A whole exchange - every consecutive WhatsApp message grouped under one step. */
function WhatsAppAttemptCard({ entries }: { entries: TimelineEntry[] }) {
  const first = entries[0];
  const anyOutOfWindow = entries.some((e) => e.in_window === false);
  return (
    <div className="rounded-xl border p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Image src="/icons/whatsapp.png" alt="WhatsApp" width={18} height={18} className="rounded-[4px]" unoptimized />
        <span className="text-sm font-semibold">WhatsApp</span>
        {anyOutOfWindow && (
          <Badge variant="outline" className={cn("text-xs", STATUS_CLASS.chasing)}>outside window</Badge>
        )}
        <span className="text-muted-foreground ml-auto text-xs tabular-nums">
          {shortDate(first.created_at)}
        </span>
      </div>
      <div className="bg-muted/30 mt-3 flex flex-col gap-2 rounded-lg p-3">
        {entries.map((e) => <WhatsAppBubble key={e.id} entry={e} />)}
      </div>
    </div>
  );
}

/** What a no-channel decision looked like, mapped from the agent's own vocabulary. */
const RESOLUTION_META: Record<
  string,
  { label: string; icon: React.ComponentType<{ className?: string }>; tone: "good" | "bad" | "muted" }
> = {
  stop: { label: "Stopped contacting", icon: BanIcon, tone: "muted" },
  escalate_human: { label: "Escalated to a human", icon: UserIcon, tone: "bad" },
  schedule_retry: { label: "Retry scheduled", icon: RotateCcwIcon, tone: "muted" },
  request_new_method: { label: "Asked for a new payment method", icon: CreditCardIcon, tone: "muted" },
  send_message: { label: "Message queued", icon: SendIcon, tone: "muted" },
};

function ResolutionCard({ entry }: { entry: TimelineEntry }) {
  const resolution = entry.intervention ? RESOLUTION_META[entry.intervention] : undefined;
  const Icon = resolution?.icon ?? InfoIcon;
  const label = resolution?.label ?? outcomeMeta(entry.outcome).label;
  const tone = resolution?.tone ?? outcomeMeta(entry.outcome).tone;

  return (
    <div className="bg-muted/30 rounded-xl border border-dashed p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Icon className={cn("size-4 shrink-0", tone === "good" ? "text-emerald-600 dark:text-emerald-400" : tone === "bad" ? "text-red-600 dark:text-red-400" : "text-muted-foreground")} aria-hidden="true" />
        <span className="text-sm font-semibold">{label}</span>
        <GuardrailBadge guardrail={entry.guardrail} />
        <span className="text-muted-foreground ml-auto text-xs tabular-nums">
          {shortTime(entry.created_at)}
        </span>
      </div>
      {entry.rationale && <p className="text-muted-foreground mt-1.5 text-sm">{entry.rationale}</p>}
    </div>
  );
}

/** The final word on this event, once the provider has actually confirmed it. */
function ResolvedBanner({ row }: { row: BoardRow }) {
  if (!row.recovered_at) return null;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900 dark:bg-emerald-950/40">
      <CircleCheckIcon className="size-7 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
      <div className="min-w-0">
        <div className="font-semibold text-emerald-800 dark:text-emerald-300">Recovered</div>
        <div className="text-sm text-emerald-700/80 dark:text-emerald-400/80">
          Payment of {formatINR(row.amount)} confirmed on {shortDate(row.recovered_at)}
        </div>
      </div>
    </div>
  );
}

/**
 * The timeline as a story, not a table: consecutive WhatsApp messages are one
 * exchange, so they group into a single numbered step instead of one per
 * message - which is also the only way to show a reply next to what it
 * replied to.
 */
type AttemptGroup =
  | { kind: "email" | "voice" | "resolution" | "admin"; entry: TimelineEntry }
  | { kind: "whatsapp"; entries: TimelineEntry[] };

function groupAttempts(entries: TimelineEntry[]): AttemptGroup[] {
  const groups: AttemptGroup[] = [];
  for (const e of entries) {
    if (e.channel === "whatsapp") {
      const last = groups[groups.length - 1];
      if (last?.kind === "whatsapp") { last.entries.push(e); continue; }
      groups.push({ kind: "whatsapp", entries: [e] });
    } else if (e.channel === "email") {
      groups.push({ kind: "email", entry: e });
    } else if (e.channel === "voice") {
      groups.push({ kind: "voice", entry: e });
    } else if (e.admin_action) {
      groups.push({ kind: "admin", entry: e });
    } else {
      groups.push({ kind: "resolution", entry: e });
    }
  }
  return groups;
}

/**
 * A merchant's own intervention, in the same stack as the automated attempts
 * - grey and plain on purpose, so it reads as "someone stepped in here"
 * without competing visually with the channel cards around it.
 */
function AdminActionCard({ entry }: { entry: TimelineEntry }) {
  const id = entry.admin_action as AdminActionId | null;
  const def = id ? ADMIN_ACTIONS[id] : null;
  const Icon = id ? ADMIN_ACTION_ICON[id] : UserCogIcon;

  return (
    <div className="bg-muted/40 rounded-xl border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="bg-muted flex size-6 shrink-0 items-center justify-center rounded-full">
          <UserCogIcon className="size-3.5" aria-hidden="true" />
        </span>
        <span className="text-sm font-semibold">Admin action</span>
        <Badge variant="secondary" className="gap-1 text-xs">
          <Icon className="size-3" />
          {def?.label ?? entry.admin_action}
        </Badge>
        <span className="text-muted-foreground ml-auto text-xs tabular-nums">
          {shortTime(entry.created_at)}
        </span>
      </div>
      {entry.rationale && <p className="text-muted-foreground mt-2 text-sm">{entry.rationale}</p>}
    </div>
  );
}

function AttemptGroupCard({ group }: { group: AttemptGroup }) {
  if (group.kind === "email") return <EmailAttemptCard entry={group.entry} />;
  if (group.kind === "voice") return <VoiceAttemptCard entry={group.entry} />;
  if (group.kind === "whatsapp") return <WhatsAppAttemptCard entries={group.entries} />;
  if (group.kind === "admin") return <AdminActionCard entry={group.entry} />;
  return <ResolutionCard entry={group.entry} />;
}

/** One numbered rail step: a marker connected to the next by a running line. */
function TimelineStep({
  index, isLast, children,
}: {
  index: number;
  isLast: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <span className="border-primary text-primary bg-background z-10 flex size-6 shrink-0 items-center justify-center rounded-full border-2 text-[11px] font-bold tabular-nums">
          {index}
        </span>
        {!isLast && <span className="bg-border w-px flex-1" aria-hidden="true" />}
      </div>
      <div className="min-w-0 flex-1 pb-4">{children}</div>
    </div>
  );
}

/* ── detail panel ────────────────────────────────────────────────────────── */

function DetailPanel({
  row, entries, error, onClose,
}: {
  row: BoardRow;
  entries: TimelineEntry[] | null;
  error: string | null;
  onClose: () => void;
}) {
  const sent = entries?.filter((e) => e.in_window !== null) ?? [];
  const outOfWindow = sent.filter((e) => e.in_window === false).length;
  // The agent's own conversation-summary notes are memory, not something that
  // happened to the customer - they never render as a step, so an event whose
  // only rows are summaries must fall back to the empty state rather than an
  // empty gap where the timeline should be.
  const visible = entries?.filter((e) => !e.message?.startsWith(SUMMARY_PREFIX)) ?? [];
  const groups = groupAttempts(visible);
  const stepCount = groups.length + (row.recovered_at ? 1 : 0);
  const elapsed =
    row.recovered_at !== null
      ? (Date.parse(row.recovered_at) - Date.parse(row.failed_on)) / 1000
      : (Date.now() - Date.parse(row.failed_on)) / 1000;

  return (
    <Card className="gap-0 py-0 h-full max-h-full overflow-hidden">
      <div className="flex items-center gap-2 border-b p-3 sm:px-4">
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Back to the table">
          <ArrowLeftIcon className="size-4" />
        </Button>
        <span className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
          Customer detail panel
        </span>
      </div>

      <div className="flex items-center gap-3 border-b p-4 sm:p-6">
        <Avatar className="size-10">
          <AvatarFallback className="text-sm font-bold">{initials(row.customer_name)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{row.customer_name ?? "Unknown customer"}</div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
            <strong className="tabular-nums">{formatINR(row.amount)}</strong>
            <WorkflowBadge workflow={row.workflow} />
            <Badge variant="secondary">{row.reason_label}</Badge>
            <StatusBadge status={row.status} />
            <ChannelMark channel={row.last_channel} />
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && <p className="text-destructive p-8 text-center text-sm">{error}</p>}
        {!entries && !error && (
          <p className="text-muted-foreground p-8 text-center text-sm">Loading the timeline…</p>
        )}
        {entries && groups.length === 0 && !row.recovered_at && (
          <p className="text-muted-foreground p-8 text-center text-sm">
            Nothing has happened on this event yet.
          </p>
        )}

        {entries && stepCount > 0 && (
          <div className="p-4 sm:p-6">
            {groups.map((g, i) => (
              <TimelineStep
                key={g.kind === "whatsapp" ? g.entries[0].id : g.entry.id}
                index={i + 1}
                isLast={i === groups.length - 1 && !row.recovered_at}
              >
                <AttemptGroupCard group={g} />
              </TimelineStep>
            ))}
            {row.recovered_at && (
              <TimelineStep index={groups.length + 1} isLast>
                <ResolvedBanner row={row} />
              </TimelineStep>
            )}
          </div>
        )}
      </div>

      <Separator />
      <div className="text-muted-foreground shrink-0 p-4 text-sm sm:px-6">
        {row.status === "recovered"
          ? <>Recovered in <strong className="text-foreground">{formatDuration(elapsed)}</strong></>
          : <>Open for <strong className="text-foreground">{formatDuration(elapsed)}</strong></>}
        {" · "}<strong className="text-foreground">{row.attempts}</strong> of {row.max_attempts} attempts used{" · "}
        {sent.length === 0 ? "nothing sent yet"
          : outOfWindow === 0
            ? <span className="font-semibold text-emerald-600 dark:text-emerald-400">all {sent.length} messages within the contact window</span>
            : <span className="font-semibold text-amber-600 dark:text-amber-400">{outOfWindow} of {sent.length} sent outside the contact window</span>}
      </div>
    </Card>
  );
}
