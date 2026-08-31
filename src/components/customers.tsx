"use client";

/**
 * Customers: every case for this business, on its own page.
 *
 * Split out of the Overview, which now keeps the numbers and the charts. The
 * table itself lives in CaseBoard, shared with Overview, which renders it
 * again below its charts - this page is just that plus a page header.
 */
import { CalendarIcon } from "lucide-react";

import { RANGES, type Dashboard } from "@/lib/board";
import { cn } from "@/lib/utils";
import { useDashboardStream } from "@/hooks/use-dashboard-stream";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CaseBoard } from "@/components/case-board";
import { useRouter } from "next/navigation";

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

      <CaseBoard slug={slug} data={data} setData={setData} />
    </div>
  );
}
