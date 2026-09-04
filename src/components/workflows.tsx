"use client";

/**
 * Workflows: which of the four kinds of recovery this merchant runs, and
 * what each one has actually done.
 *
 * The toggle used to live in Settings, buried under contact rules and the
 * model picker. It moved here because switching a category on or off is a
 * decision worth making next to the evidence for it - what that workflow has
 * recovered so far - rather than in a form of unrelated operational details.
 */
import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { ListChecksIcon } from "lucide-react";

import { formatINR } from "@/lib/types";
import { WORKFLOW_IDS, WORKFLOWS, type WorkflowId } from "@/lib/workflows";
import { workflowStats, type Dashboard } from "@/lib/board";
import { useDashboardStream } from "@/hooks/use-dashboard-stream";
import { WORKFLOW_SHORT } from "@/components/case-parts";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

const CHART_CONFIG = {
  recovery_rate: { label: "Recovery rate", color: "var(--chart-2)" },
} satisfies ChartConfig;

export function Workflows({
  slug,
  merchantId,
  initial,
}: {
  slug: string;
  merchantId: string;
  initial: Dashboard;
}) {
  const { data } = useDashboardStream(slug, initial);
  const [enabled, setEnabled] = useState<WorkflowId[]>(initial.workflows_enabled);
  const [busy, setBusy] = useState<WorkflowId | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A save from another tab, or the stream's own periodic snapshot, should
  // win over whatever this tab last rendered - same reasoning as the board
  // rows themselves.
  useEffect(() => setEnabled(data.workflows_enabled), [data.workflows_enabled]);

  const stats = useMemo(() => workflowStats(data.rows), [data.rows]);
  const statFor = (id: WorkflowId) => stats.find((s) => s.workflow === id)!;

  const chartData = WORKFLOW_IDS.map((id) => ({
    workflow: WORKFLOW_SHORT[id],
    recovery_rate: statFor(id).recovery_rate,
  }));

  async function toggle(id: WorkflowId) {
    const was = enabled;
    const next = was.includes(id)
      ? was.filter((x) => x !== id)
      : WORKFLOW_IDS.filter((x) => x === id || was.includes(x));
    setEnabled(next);
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/merchants/${merchantId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflows_enabled: next }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) {
        setEnabled(was);
        setError(json.error ?? "Could not save that change.");
      }
    } catch {
      setEnabled(was);
      setError("Could not reach Tally. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <ListChecksIcon className="text-muted-foreground size-6" />
          Workflows
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          The kinds of recovery Tally runs for you. Everything is still
          detected and classified whatever you switch off - a workflow that is
          off means Tally will not contact anyone about it, not that it stops
          watching. Changes apply to new cases; anything already mid-flow
          carries on.
        </p>
      </div>

      <Card>
        <CardContent className="space-y-5">
          {WORKFLOW_IDS.map((id) => {
            const w = WORKFLOWS[id];
            const on = enabled.includes(id);
            return (
              <div key={id} className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <Label htmlFor={`wf-${id}`} className="font-semibold">
                    {w.label}
                  </Label>
                  <p className="text-muted-foreground mt-0.5 text-sm">{w.summary}</p>
                  <p className="text-muted-foreground/80 mt-0.5 text-xs">{w.covers}</p>
                </div>
                <Switch
                  id={`wf-${id}`}
                  checked={on}
                  disabled={busy === id}
                  onCheckedChange={() => void toggle(id)}
                />
              </div>
            );
          })}
          {error && <p className="text-destructive text-sm">{error}</p>}
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {WORKFLOW_IDS.map((id) => {
          const s = statFor(id);
          const on = enabled.includes(id);
          return (
            <Card key={id} className={cn(!on && "opacity-60")}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold">
                  {WORKFLOW_SHORT[id]}
                </CardTitle>
                {!on && (
                  <span className="text-muted-foreground text-xs">Switched off</span>
                )}
              </CardHeader>
              <CardContent className="space-y-2">
                <div>
                  <div className="text-xl font-bold tabular-nums">
                    {formatINR(s.amount_recovered)}
                  </div>
                  <div className="text-muted-foreground text-xs">Amount recovered</div>
                </div>
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-muted-foreground">
                    {s.customers} {s.customers === 1 ? "customer" : "customers"}
                  </span>
                  <span className="font-semibold tabular-nums">
                    {s.recovery_rate}% recovered
                  </span>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recovery rate by workflow</CardTitle>
          <span className="text-muted-foreground text-xs">
            Of everything each workflow has chased that has reached a conclusion
          </span>
        </CardHeader>
        <CardContent>
          <ChartContainer config={CHART_CONFIG} className="h-[220px] w-full">
            <BarChart data={chartData} margin={{ left: 4, right: 12, top: 6 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="workflow" tickLine={false} axisLine={false} tickMargin={10} />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickMargin={6}
                width={36}
                domain={[0, 100]}
                tickFormatter={(v: number) => `${v}%`}
              />
              <ChartTooltip
                content={<ChartTooltipContent formatter={(v) => `${v}%`} />}
              />
              <Bar
                dataKey="recovery_rate"
                fill="var(--color-recovery_rate)"
                radius={[4, 4, 0, 0]}
                isAnimationActive={false}
              />
            </BarChart>
          </ChartContainer>
        </CardContent>
      </Card>
    </div>
  );
}
