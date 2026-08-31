"use client";

/**
 * The Overview: this business's recovery, in numbers, charts, and the case
 * table underneath.
 *
 * Server-rendered once with real figures, then kept current by the SSE stream
 * in /api/dashboard/[slug]/stream. The table itself is CaseBoard, shared with
 * the dedicated Customers page - one implementation of "the case table"
 * rather than two that could drift apart.
 */
import { useCallback } from "react";
import { useRouter } from "next/navigation";
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
  CalendarIcon,
  XIcon,
} from "lucide-react";

import { formatINR } from "@/lib/types";
import {
  STATUS_META,
  RANGES,
  delta,
  type Dashboard,
} from "@/lib/board";
import { WORKFLOWS, WORKFLOW_IDS, WORKFLOW_COUNT } from "@/lib/workflows";
import { cn } from "@/lib/utils";
import { useDashboardStream } from "@/hooks/use-dashboard-stream";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import {
  ChannelMark,
  DOT_CLASS,
  WorkflowPills,
  compactINR,
} from "@/components/case-parts";
import { CaseBoard } from "@/components/case-board";

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
  const { data, setData, live } = useDashboardStream(slug, initial);

  const m = data.metrics;
  const p = data.previous;

  const compliance = m.sent_total === 0 ? null : Math.round((m.sent_in_window / m.sent_total) * 100);
  // How many of the enabled workflows actually saw a case in this window.
  // The headline number is what the merchant switched on; this is what
  // actually happened, which is usually the smaller and more interesting one.
  const activeWorkflows = new Set(
    data.rows.map((r) => r.workflow).filter((w) => w !== null),
  ).size;
  const prevCompliance = p.sent_total === 0 ? null : Math.round((p.sent_in_window / p.sent_total) * 100);

  /**
   * The whole window, not a filtered view: the filters that used to narrow
   * this live on the Customers page now, so an export from here is the
   * report for the period rather than for whatever was on screen.
   */
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
      ...data.rows.map((r) =>
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
  }, [data.rows, m, compliance, data.days, data.from, data.to, data.workflows_enabled, slug]);

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
          // Same bg-card/ring/shadow treatment as every other card on this
          // page, deliberately: a tinted background and a colour-matched
          // border read as decoration once there are four of them in a row -
          // the icon chip alone is enough colour to tell them apart.
          <Card key={s.label} size="sm" className="gap-0">
            <CardContent className="flex items-start gap-3">
              <div
                className="flex size-9 shrink-0 items-center justify-center rounded-lg"
                style={{ background: `color-mix(in oklab, ${s.colour} 14%, transparent)`, color: s.colour }}
              >
                {s.icon}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className={cn("size-1.5 rounded-full", DOT_CLASS[s.tone])} aria-hidden="true" />
                  <span className="text-muted-foreground truncate text-xs font-semibold tracking-wide uppercase">
                    {s.label}
                  </span>
                </div>
                <div className="mt-1 text-2xl font-bold tracking-tight tabular-nums">{s.value}</div>
                <p className="text-muted-foreground mt-0.5 truncate text-xs">{s.sub}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ── case table ── */}
      <CaseBoard slug={slug} data={data} setData={setData} />
    </div>
  );
}
