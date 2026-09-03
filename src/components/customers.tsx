"use client";

/**
 * Customers: every case for this business, on its own page.
 *
 * Split out of the Overview, which now keeps the numbers and the charts. The
 * table itself lives in CaseBoard, shared with Overview, which renders it
 * again below its charts - this page is just that plus a page header.
 */
import {
  CalendarIcon,
  ClockIcon,
  ShieldCheckIcon,
  SparklesIcon,
  TrendingDownIcon,
  TrendingUpIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { formatINR } from "@/lib/types";
import { RANGES, delta, formatDuration, type Dashboard } from "@/lib/board";
import { cn } from "@/lib/utils";
import { useDashboardStream } from "@/hooks/use-dashboard-stream";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CaseBoard } from "@/components/case-board";
import { useRouter } from "next/navigation";

/** Plain coloured arrow + percentage - up is green or red, down the other
 * way round, depending on whether a rise on this particular metric is good
 * news. No pill, no background: just the arrow, the colour and the number. */
function DeltaIndicator({
  value, riseIsGood = true, suffix = "%",
}: {
  value: number | null;
  riseIsGood?: boolean;
  suffix?: string;
}) {
  if (value === null || value === 0) return null;
  const good = value > 0 === riseIsGood;
  const Icon = value > 0 ? TrendingUpIcon : TrendingDownIcon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs font-semibold tabular-nums",
        good ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400",
      )}
    >
      <Icon className="size-3.5" />
      {Math.abs(value)}{suffix}
    </span>
  );
}

/**
 * The three tiles, as one object.
 *
 * Five flat numbers became three that each carry their own context. "₹10,896"
 * on its own is a fact nobody can act on; "17% - ₹10,896 of ₹64,885" is the
 * same fact with the question it answers attached, and the reader stops having
 * to hold three tiles in their head to make the fourth mean anything.
 *
 * One accent per tile, and the accent is semantic rather than decorative:
 * green is money returning, amber is a queue with people in it, violet is the
 * agent's own work. Full literal class strings because Tailwind scans source
 * text and cannot find a class built at runtime.
 */
const TONES = {
  emerald: {
    value: "text-emerald-600 dark:text-emerald-400",
    chip: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    bar: "bg-emerald-500",
    track: "bg-emerald-500/15",
  },
  amber: {
    value: "text-amber-600 dark:text-amber-400",
    chip: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    bar: "bg-amber-500",
    track: "bg-amber-500/15",
  },
  violet: {
    value: "text-violet-600 dark:text-violet-400",
    chip: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
    bar: "bg-violet-500",
    track: "bg-violet-500/15",
  },
  sky: {
    value: "text-sky-600 dark:text-sky-400",
    chip: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
    bar: "bg-sky-500",
    track: "bg-sky-500/15",
  },
  indigo: {
    value: "text-indigo-600 dark:text-indigo-400",
    chip: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
    bar: "bg-indigo-500",
    track: "bg-indigo-500/15",
  },
  slate: {
    value: "text-slate-700 dark:text-slate-200",
    chip: "bg-slate-500/10 text-slate-600 dark:text-slate-300",
    bar: "bg-slate-500",
    track: "bg-slate-500/15",
  },
} as const;

type Tone = keyof typeof TONES;

/** The line every tile opens with: tinted icon, label, and any delta. */
function TileHead({
  label, icon: Icon, tone, deltaValue, riseIsGood = true, suffix = "%",
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: Tone;
  deltaValue?: number | null;
  riseIsGood?: boolean;
  suffix?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-md",
          TONES[tone].chip,
        )}
      >
        <Icon className="size-3.5" />
      </span>
      <span className="text-muted-foreground min-w-0 truncate text-[0.7rem] font-medium">
        {label}
      </span>
      <span className="ml-auto shrink-0">
        <DeltaIndicator
          value={deltaValue ?? null}
          riseIsGood={riseIsGood}
          suffix={suffix}
        />
      </span>
    </div>
  );
}

/**
 * Where one figure sits between the best and worst of its kind.
 *
 * An average with no range around it hides whether it describes every case or
 * is one slow outlier dragging a pile of fast ones - and those two situations
 * want completely different things done about them.
 */
function RangeTrack({
  tone, fastest, slowest, value,
}: {
  tone: Tone;
  fastest: number;
  slowest: number;
  value: number;
}) {
  const span = slowest - fastest;
  // Everything recovered in the same time: the marker belongs in the middle,
  // not at an end, and not dividing by zero to get there.
  const pct = span <= 0 ? 50 : ((value - fastest) / span) * 100;
  return (
    <div className="flex flex-col gap-1">
      <div className={cn("relative h-1.5 w-full rounded-full", TONES[tone].track)}>
        <span
          className={cn(
            "absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card",
            TONES[tone].bar,
          )}
          style={{ left: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      </div>
      <div className="text-muted-foreground flex justify-between text-[0.6rem] tabular-nums">
        <span title="Fastest recovery in this period">{formatDuration(fastest)}</span>
        <span title="Slowest recovery in this period">{formatDuration(slowest)}</span>
      </div>
    </div>
  );
}

function StatTile({
  label, icon: Icon, tone, value, unit, detail, fill, deltaValue,
  riseIsGood = true, suffix = "%", footer,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: Tone;
  value: string;
  /** Sits on the number's baseline - "%" or "cases", never part of the value. */
  unit?: string;
  detail: React.ReactNode;
  /** 0-100. The bar is the tile's proof; a tile with no honest proportion
   *  to show gets none rather than a decorative one. */
  fill?: number;
  deltaValue?: number | null;
  riseIsGood?: boolean;
  suffix?: string;
  /** Sits where the bar would, for a tile whose proof is not a proportion. */
  footer?: React.ReactNode;
}) {
  const t = TONES[tone];
  return (
    <Card size="sm" className="gap-0">
      <CardContent className="flex flex-col gap-2 px-3">
        <TileHead
          label={label}
          icon={Icon}
          tone={tone}
          deltaValue={deltaValue}
          riseIsGood={riseIsGood}
          suffix={suffix}
        />

        <div className="flex items-baseline gap-1">
          <span className={cn("text-2xl font-bold tracking-tight tabular-nums", t.value)}>
            {value}
          </span>
          {unit && <span className="text-muted-foreground text-xs font-medium">{unit}</span>}
        </div>

        <p className="text-muted-foreground text-[0.7rem] leading-snug">{detail}</p>

        {/* Anchored to the card's bottom edge with mt-auto rather than
            following straight after the text. Detail ran to one line on some
            tiles and two on others, so the indicator used to land at whatever
            height the text happened to leave it at - every tile now fills
            evenly, with the leftover space collected above the bar instead of
            showing up as air underneath it. */}
        {(fill !== undefined || footer) && (
          <div className="mt-auto flex flex-col gap-1.5 pt-1.5">
            {fill !== undefined && (
              <div
                className={cn("h-1.5 w-full overflow-hidden rounded-full", t.track)}
                role="img"
                aria-label={`${Math.round(fill)} percent`}
              >
                <div
                  className={cn("h-full rounded-full transition-[width] duration-500", t.bar)}
                  // Clamped: a proportion over 100 would overflow its track,
                  // and one under 0 would vanish - both are possible when the
                  // two figures come from different windows.
                  style={{ width: `${Math.min(100, Math.max(0, fill))}%` }}
                />
              </div>
            )}
            {footer}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Which failures are growing, and which are receding.
 *
 * A count on its own says how common something is; the arrow says whether it
 * is getting worse, which is the half that decides what a merchant does on
 * Monday. Compared against the same cause in the window before this one.
 */
function MomentumTile({
  causes, previous,
}: {
  causes: Dashboard["metrics"]["top_causes"];
  previous: Dashboard["metrics"]["top_causes"];
}) {
  // Nothing to compare against at all, as opposed to one cause we cannot place.
  // Three dashes down the column reads as broken; saying it once, plainly,
  // reads as what it is - a window with no period before it.
  const noPrior = previous.length === 0;
  return (
    <Card size="sm" className="gap-0">
      <CardContent className="flex flex-col gap-2 px-3">
        <TileHead label="Top causes" icon={TrendingUpIcon} tone="slate" />

        {causes.length === 0 ? (
          <p className="text-muted-foreground py-2 text-[0.7rem]">
            No open failures here.
          </p>
        ) : (
          <ul className="flex flex-col">
            {causes.map((c) => {
              const before = previous.find((p) => p.reason === c.reason);
              // A cause missing from the previous window's top three might be
              // new or might have been just below the cut - unknowable from
              // here. It gets a dash, because guessing an arrow would be
              // inventing a trend out of a reporting limit.
              const dir =
                before === undefined
                  ? "unknown"
                  : c.count > before.count
                    ? "up"
                    : c.count < before.count
                      ? "down"
                      : "flat";
              return (
                <li
                  key={c.reason}
                  className="flex items-center justify-between gap-2 border-b py-1 text-[0.7rem] last:border-b-0"
                >
                  <span className="min-w-0 truncate" title={c.label}>{c.label}</span>
                  <span className="flex shrink-0 items-center gap-1 tabular-nums">
                    <span className="font-semibold">{c.count}</span>
                    {!noPrior && dir === "up" && (
                      <TrendingUpIcon
                        className="size-3.5 text-red-600 dark:text-red-400"
                        aria-label="more than last period"
                      />
                    )}
                    {!noPrior && dir === "down" && (
                      <TrendingDownIcon
                        className="size-3.5 text-emerald-600 dark:text-emerald-400"
                        aria-label="fewer than last period"
                      />
                    )}
                    {!noPrior && dir === "flat" && (
                      <span className="text-muted-foreground" aria-label="unchanged">–</span>
                    )}
                    {!noPrior && dir === "unknown" && (
                      <span
                        className="text-muted-foreground"
                        title="Not in the previous period's top causes, so there is nothing to compare against"
                        aria-label="no comparison available"
                      >
                        ·
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        {noPrior && causes.length > 0 && (
          <p className="text-muted-foreground text-[0.6rem] leading-snug">
            No earlier period to compare
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function Customers({ slug, initial }: { slug: string; initial: Dashboard }) {
  const router = useRouter();
  const { data, setData, live } = useDashboardStream(slug, initial);

  // Counted off the rows the page already holds rather than fetched: the board
  // below derives its own tab counts the same way, and two sources for one
  // number is two numbers waiting to disagree.
  const needsAttention = data.metrics.needs_human;
  const chasing = data.rows.filter((r) => r.status === "chasing").length;
  const avg = data.metrics.avg_recovery_seconds;
  const fastest = data.metrics.recovery_fastest_seconds;
  const slowest = data.metrics.recovery_slowest_seconds;

  return (
    <div className="flex flex-col gap-6">
      {/* ── top bar ── */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Customers</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Every case for this business. Open one to see what has been said, or
            act on it from the menu at the end of its row.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "flex items-center gap-1.5 text-xs font-semibold tracking-wide uppercase",
              live ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
            )}
          >
            <span
              className={cn(
                "size-1.5 rounded-full",
                live ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground/50",
              )}
            />
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
        </div>
      </div>

      {/* ── at a glance ──
          Three tiles, not five. Each one is a headline number plus the figures
          that make it mean something, so the row can be read left to right
          rather than cross-referenced. */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatTile
          label="Recovery"
          icon={TrendingUpIcon}
          tone="emerald"
          value={`${data.metrics.recovery_rate}%`}
          detail={
            <>
              <span className="text-foreground font-semibold">
                {formatINR(data.metrics.amount_recovered)}
              </span>{" "}
              back · {formatINR(data.metrics.amount_at_risk)} at risk
            </>
          }
          // The bar is the headline number, not a second calculation.
          // recovery_rate counts cases, so filling the bar by money would draw
          // one proportion under a percentage that means another - and a tile
          // whose picture disagrees with its own number is worse than a tile
          // with no picture. The money sits below as its own fact instead.
          fill={data.metrics.recovery_rate}
          deltaValue={delta(data.metrics.recovery_rate, data.previous.recovery_rate)}
        />

        <StatTile
          label="Needs attention"
          icon={TriangleAlertIcon}
          tone={needsAttention > 0 ? "amber" : "emerald"}
          value={String(needsAttention)}
          unit={needsAttention === 1 ? "case" : "cases"}
          detail={
            needsAttention > 0 ? (
              <>
                of {data.metrics.total_events} active ·{" "}
                <span className="text-foreground font-semibold">{chasing}</span> chasing
              </>
            ) : (
              <>Nobody waiting · {chasing} chasing</>
            )
          }
          // Share of the active pipeline sitting with a person rather than
          // the agent - a raw count of four means something different out of
          // six than it does out of sixty, and this is the number that says
          // which one you are looking at.
          fill={
            data.metrics.total_events > 0
              ? (needsAttention / data.metrics.total_events) * 100
              : 0
          }
        />

        <StatTile
          label="Automation"
          icon={SparklesIcon}
          tone="violet"
          value={String(data.metrics.sent_total)}
          unit={data.metrics.sent_total === 1 ? "action" : "actions"}
          detail={
            data.metrics.sent_total > 0 ? (
              <>
                unprompted ·{" "}
                <span
                  className={cn(
                    "font-semibold",
                    data.metrics.sent_in_window === data.metrics.sent_total
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-amber-600 dark:text-amber-400",
                  )}
                >
                  {data.metrics.sent_in_window}/{data.metrics.sent_total}
                </span>{" "}
                in window
              </>
            ) : (
              <>Nothing sent yet</>
            )
          }
          deltaValue={delta(data.metrics.sent_total, data.previous.sent_total)}
          // The compliance fraction already named in the sentence above,
          // drawn as well as said - what a merchant is actually answerable
          // for is the share inside the window, not the raw count sent.
          fill={
            data.metrics.sent_total > 0
              ? (data.metrics.sent_in_window / data.metrics.sent_total) * 100
              : 0
          }
        />

        <StatTile
          label="Avg recovery"
          icon={ClockIcon}
          tone="sky"
          value={avg === null ? "—" : formatDuration(avg)}
          detail={
            avg === null ? "Nothing recovered yet" : "failure to payment"
          }
          // Slower is worse, so a rise is bad news here.
          deltaValue={
            avg !== null && data.previous.avg_recovery_seconds
              ? delta(avg, data.previous.avg_recovery_seconds)
              : null
          }
          riseIsGood={false}
          footer={
            avg !== null && fastest !== null && slowest !== null ? (
              <RangeTrack tone="sky" fastest={fastest} slowest={slowest} value={avg} />
            ) : undefined
          }
        />

        <StatTile
          label="Guardrails"
          icon={ShieldCheckIcon}
          tone="indigo"
          value={String(data.metrics.guardrail_actions)}
          unit={data.metrics.guardrail_actions === 1 ? "action" : "actions"}
          detail={
            data.metrics.total_actions > 0 ? (
              <>of {data.metrics.total_actions} decisions · rule overrode the model</>
            ) : (
              <>rule overrode the model</>
            )
          }
          deltaValue={delta(
            data.metrics.guardrail_actions,
            data.previous.guardrail_actions,
          )}
          riseIsGood={false}
          // Share of every decision this window where a rule, not the model,
          // had the final word - the figure that actually backs up "the agent
          // proposes, the guardrails dispose" instead of just asserting it.
          fill={
            data.metrics.total_actions > 0
              ? (data.metrics.guardrail_actions / data.metrics.total_actions) * 100
              : 0
          }
        />

        <MomentumTile
          causes={data.metrics.top_causes}
          previous={data.previous.top_causes}
        />
      </div>

      <CaseBoard slug={slug} data={data} setData={setData} />
    </div>
  );
}
