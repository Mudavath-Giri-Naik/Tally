"use client";

/**
 * Customers: every case for this business, on its own page.
 *
 * Split out of the Overview, which now keeps the numbers and the charts. The
 * table itself lives in CaseBoard, shared with Overview, which renders it
 * again below its charts - this page is just that plus a page header.
 */
import { CalendarIcon, TrendingDownIcon, TrendingUpIcon } from "lucide-react";

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

function StatTile({
  label, value, deltaValue, riseIsGood = true, suffix = "%",
}: {
  label: string;
  value: string;
  deltaValue: number | null;
  riseIsGood?: boolean;
  suffix?: string;
}) {
  return (
    <Card size="sm" className="gap-0">
      <CardContent className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs font-medium">{label}</span>
          <DeltaIndicator value={deltaValue} riseIsGood={riseIsGood} suffix={suffix} />
        </div>
        <span className="text-2xl font-bold tracking-tight tabular-nums">{value}</span>
      </CardContent>
    </Card>
  );
}

export function Customers({ slug, initial }: { slug: string; initial: Dashboard }) {
  const router = useRouter();
  const { data, setData, live } = useDashboardStream(slug, initial);

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

      {/* ── at a glance ── */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-5">
        <StatTile
          label="Total at risk" value={formatINR(data.metrics.amount_at_risk)}
          deltaValue={delta(data.metrics.amount_at_risk, data.previous.amount_at_risk)}
          riseIsGood={false}
        />
        <StatTile
          label="Recovered" value={formatINR(data.metrics.amount_recovered)}
          deltaValue={delta(data.metrics.amount_recovered, data.previous.amount_recovered)}
        />
        <StatTile
          label="Recovery rate" value={`${data.metrics.recovery_rate}%`}
          deltaValue={delta(data.metrics.recovery_rate, data.previous.recovery_rate)}
        />
        <StatTile
          label="Active cases" value={String(data.metrics.total_events)}
          deltaValue={data.metrics.total_events - data.previous.total_events}
          suffix=""
        />
        <StatTile
          label="Automated actions" value={String(data.metrics.sent_total)}
          deltaValue={delta(data.metrics.sent_total, data.previous.sent_total)}
        />
      </div>

      <CaseBoard slug={slug} data={data} setData={setData} />
    </div>
  );
}
