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
  SparklesIcon,
  TrendingDownIcon,
  TrendingUpIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { formatINR } from "@/lib/types";
import { RANGES, delta, type Dashboard } from "@/lib/board";
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
} as const;

type Tone = keyof typeof TONES;

function StatTile({
  label, icon: Icon, tone, value, unit, detail, fill, deltaValue,
  riseIsGood = true, suffix = "%",
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
}) {
  const t = TONES[tone];
  return (
    <Card size="sm" className="gap-0">
      <CardContent className="flex flex-col gap-2.5">
        <div className="flex items-center gap-2">
          <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-md", t.chip)}>
            <Icon className="size-3.5" />
          </span>
          <span className="text-muted-foreground text-xs font-medium">{label}</span>
          <span className="ml-auto">
            <DeltaIndicator
              value={deltaValue ?? null}
              riseIsGood={riseIsGood}
              suffix={suffix}
            />
          </span>
        </div>

        <div className="flex items-baseline gap-1.5">
          <span className={cn("text-3xl font-bold tracking-tight tabular-nums", t.value)}>
            {value}
          </span>
          {unit && <span className="text-muted-foreground text-sm font-medium">{unit}</span>}
        </div>

        <p className="text-muted-foreground text-xs leading-relaxed">{detail}</p>

        {fill !== undefined && (
          <div
            className={cn("h-1.5 w-full overflow-hidden rounded-full", t.track)}
            role="img"
            aria-label={`${Math.round(fill)} percent`}
          >
            <div
              className={cn("h-full rounded-full transition-[width] duration-500", t.bar)}
              // Clamped: a proportion over 100 would overflow its track, and
              // one under 0 would vanish - both are possible when the two
              // figures come from different windows.
              style={{ width: `${Math.min(100, Math.max(0, fill))}%` }}
            />
          </div>
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
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
              recovered · {formatINR(data.metrics.amount_at_risk)} still at risk
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
                <span className="text-foreground font-semibold">{chasing}</span> in
                auto-chase
              </>
            ) : (
              <>Nothing waiting on a person · {chasing} in auto-chase</>
            )
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
                sent on its own ·{" "}
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
                inside your contact window
              </>
            ) : (
              <>Nothing sent in this window</>
            )
          }
          deltaValue={delta(data.metrics.sent_total, data.previous.sent_total)}
        />
      </div>

      <CaseBoard slug={slug} data={data} setData={setData} />
    </div>
  );
}
