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
} from "lucide-react";

import { formatINR } from "@/lib/types";
import {
  BOARD_STATUSES,
  STATUS_META,
  RANGES,
  WORKFLOW_TYPE_COUNT,
  formatDuration,
  delta,
  type Dashboard,
  type BoardRow,
  type BoardStatus,
  type TimelineEntry,
} from "@/lib/board";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
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
};

const DOT_CLASS: Record<string, string> = {
  recovered: "bg-emerald-500",
  chasing: "bg-amber-500",
  voice: "bg-blue-500",
  human: "bg-red-500",
  stopped: "bg-muted-foreground/60",
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

  useEffect(() => setData(initial), [initial]);

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
      return (
        (r.customer_name ?? "").toLowerCase().includes(q) ||
        r.reason_label.toLowerCase().includes(q) ||
        r.reason.toLowerCase().includes(q) ||
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

  const toggleRow = useCallback(
    async (eventId: string) => {
      if (openEvent === eventId) { setOpenEvent(null); return; }
      setOpenEvent(eventId);
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
    [openEvent, slug],
  );

  const compliance = m.sent_total === 0 ? null : Math.round((m.sent_in_window / m.sent_total) * 100);
  // Distinct event types active in this window, out of the fixed six the
  // schema allows - "workflow" here means the kind of recovery, not a
  // per-tenant configuration.
  const activeWorkflows = new Set(data.rows.map((r) => r.event_type)).size;
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
      "Customer,Amount,Reason,Channel,Status,Attempts,Failed on",
      ...filtered.map((r) =>
        [
          esc(r.customer_name ?? "Unknown"),
          r.amount === null ? "" : r.amount / 100,
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
  }, [filtered, m, compliance, data.days, data.from, data.to, slug]);

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
          label="Active workflows" value={String(activeWorkflows)}
          sub={`of ${WORKFLOW_TYPE_COUNT} workflow types`}
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

      {/* ── table ── */}
      <Card className="gap-0 py-0">
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
                  <TableHead>Reason</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Attempts</TableHead>
                  <TableHead>Failed on</TableHead>
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
                    <TableCell><Badge variant="secondary">{row.reason_label}</Badge></TableCell>
                    <TableCell><ChannelMark channel={row.last_channel} /></TableCell>
                    <TableCell><StatusBadge status={row.status} /></TableCell>
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
        <DetailPanel row={openRow} entries={timeline} error={timelineError}
                     onClose={() => setOpenEvent(null)} />
      )}
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
  const elapsed =
    row.recovered_at !== null
      ? (Date.parse(row.recovered_at) - Date.parse(row.failed_on)) / 1000
      : (Date.now() - Date.parse(row.failed_on)) / 1000;

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center gap-3 border-b p-4 sm:p-6">
        <Avatar className="size-10">
          <AvatarFallback className="text-sm font-bold">{initials(row.customer_name)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{row.customer_name ?? "Unknown customer"}</div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
            <strong className="tabular-nums">{formatINR(row.amount)}</strong>
            <Badge variant="secondary">{row.reason_label}</Badge>
            <StatusBadge status={row.status} />
            <ChannelMark channel={row.last_channel} />
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
          <XIcon className="size-4" />
        </Button>
      </div>

      {error && <p className="text-destructive p-8 text-center text-sm">{error}</p>}
      {!entries && !error && (
        <p className="text-muted-foreground p-8 text-center text-sm">Loading the timeline…</p>
      )}
      {entries && entries.length === 0 && (
        <p className="text-muted-foreground p-8 text-center text-sm">
          Nothing has happened on this event yet.
        </p>
      )}

      {entries && entries.length > 0 && (
        <ol className="p-4 sm:p-6">
          {entries.map((e) => (
            <li key={e.id} className="border-border relative grid gap-3 border-l py-3 pl-5 sm:grid-cols-[112px_minmax(0,1fr)]">
              <span
                className={cn(
                  "border-background absolute -left-[5px] top-[18px] size-2.5 rounded-full border-2",
                  e.outcome === "sent" || e.outcome === "delivered" ? "bg-emerald-500"
                    : e.outcome === "escalated" ? "bg-red-500"
                      : e.outcome === "failed" ? "bg-destructive" : "bg-muted-foreground/60",
                )}
                aria-hidden="true"
              />
              <span className="text-muted-foreground text-xs tabular-nums">{shortTime(e.created_at)}</span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn(
                    "text-xs font-bold uppercase tracking-wide",
                    e.outcome === "sent" || e.outcome === "delivered" ? "text-emerald-600 dark:text-emerald-400"
                      : e.outcome === "escalated" ? "text-red-600 dark:text-red-400"
                        : "text-muted-foreground",
                  )}>
                    {e.outcome.replace(/_/g, " ")}
                  </span>
                  {e.channel && <Badge variant="outline" className="text-xs">{e.channel}</Badge>}
                  {e.in_window === false && (
                    <Badge variant="outline" className={cn("text-xs", STATUS_CLASS.chasing)}>
                      outside window
                    </Badge>
                  )}
                  {e.guardrail && (
                    <Badge variant="secondary" className="text-xs">{e.guardrail.replace(/_/g, " ")}</Badge>
                  )}
                </div>
                {e.rationale && <p className="text-muted-foreground mt-1.5 text-sm">{e.rationale}</p>}
                {e.message && (
                  <p className="bg-muted text-muted-foreground mt-2 rounded-md border p-2.5 text-sm whitespace-pre-wrap">
                    {e.message}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}

      <Separator />
      <div className="text-muted-foreground p-4 text-sm sm:px-6">
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
