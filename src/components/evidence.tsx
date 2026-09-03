/**
 * The Evidence page.
 *
 * Two halves, in this order on purpose: did it work, then did it behave. A
 * merchant reads the recovery figure first whatever we do, so the honest thing
 * is to put the caveats on it in the same eyeline rather than a section below -
 * an unqualified number at the top and its qualification further down is how a
 * dashboard misleads without printing anything false.
 */
import {
  CircleCheckIcon,
  TriangleAlertIcon,
  InfoIcon,
} from "lucide-react";

import { formatINR } from "@/lib/types";
import { formatCost } from "@/lib/costs";
import {
  MIN_CONTROL_EVENTS,
  returnOnSpend,
  type CausePerformance,
  type Invariant,
  type Lift,
  type SendHour,
  type Spend,
} from "@/lib/evidence";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

/* ── did it work ─────────────────────────────────────────────────────────── */

function ArmRow({
  label, events, recovered, rate, muted = false, note,
}: {
  label: string;
  events: number;
  recovered: number;
  rate: number;
  muted?: boolean;
  note?: string;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3">
      <div className="flex min-w-0 flex-col">
        <span className={cn("text-sm font-medium", muted && "text-muted-foreground")}>
          {label}
        </span>
        {note && <span className="text-muted-foreground text-xs">{note}</span>}
      </div>
      <div className="flex items-baseline gap-3 tabular-nums">
        <span className="text-muted-foreground text-xs">
          {recovered}/{events}
        </span>
        <span className={cn("text-lg font-semibold", muted && "text-muted-foreground")}>
          {rate.toFixed(1)}%
        </span>
      </div>
    </div>
  );
}

function LiftCard({ lift }: { lift: Lift }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Is it the agent, or would they have paid anyway?</CardTitle>
        <p className="text-muted-foreground text-sm">
          A share of your customers is held back and never contacted. Both
          groups are counted the same way, so the gap between them is the part
          of recovery Tally can actually claim.
        </p>
      </CardHeader>
      <CardContent>
        <div className="divide-y">
          <ArmRow
            label="Contacted"
            events={lift.contacted.events}
            recovered={lift.contacted.recovered}
            rate={lift.contacted.rate}
          />
          {lift.control ? (
            <ArmRow
              label="Held back"
              note="never contacted"
              muted
              events={lift.control.events}
              recovered={lift.control.recovered}
              rate={lift.control.rate}
            />
          ) : (
            <p className="text-muted-foreground py-3 text-sm">
              No control group. Set a holdout above 0% in Settings and the
              comparison starts from the next failed payment.
            </p>
          )}
        </div>

        {lift.points !== null && (
          <div className="mt-4 border-t pt-4">
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-sm font-medium">Incremental lift</span>
              <span className="text-2xl font-bold tabular-nums">
                {lift.points >= 0 ? "+" : ""}
                {lift.points.toFixed(1)} pts
              </span>
            </div>

            {/*
              The caveat sits with the number, not in a footnote. A lift over a
              handful of events is not evidence, and a merchant repeating it in
              a board meeting because we displayed it without comment is a
              failure of this page rather than of their arithmetic.
            */}
            {!lift.significant && (
              <p className="text-muted-foreground mt-2 flex items-start gap-2 text-xs">
                <InfoIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>
                  Too early to rely on. The held-back group is{" "}
                  {lift.control?.events ?? 0} case
                  {lift.control?.events === 1 ? "" : "s"}; a figure worth
                  quoting needs at least {MIN_CONTROL_EVENTS}.
                </span>
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SpendCard({ spend, recovered }: { spend: Spend; recovered: number }) {
  const ratio = returnOnSpend(recovered, spend.total_paise);
  return (
    <Card>
      <CardHeader>
        <CardTitle>What the chasing cost</CardTitle>
        <p className="text-muted-foreground text-sm">
          Messaging spend against what came back. Recovery without the cost
          beside it is half of a subtraction.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <div className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
              Recovered
            </div>
            <div className="text-xl font-bold tabular-nums">{formatINR(recovered)}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
              Spent
            </div>
            <div className="text-xl font-bold tabular-nums">
              {formatCost(spend.total_paise)}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
              Per rupee spent
            </div>
            <div className="text-xl font-bold tabular-nums">
              {ratio === null ? "—" : `₹${ratio}`}
            </div>
          </div>
        </div>

        {spend.byChannel.length > 0 && (
          <div className="divide-y border-t pt-1">
            {spend.byChannel.map((c) => (
              <div
                key={c.channel}
                className="flex items-center justify-between py-2 text-sm"
              >
                <span className="capitalize">{c.channel}</span>
                <span className="text-muted-foreground tabular-nums">
                  {c.sent} sent · {formatCost(c.cost_paise)}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CausesCard({ causes }: { causes: CausePerformance[] }) {
  if (causes.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Which failures are worth chasing</CardTitle>
        <p className="text-muted-foreground text-sm">
          Recovery rate by root cause, ordered by what is at stake. A cause that
          almost never comes back is a dunning problem, not a chasing one.
        </p>
      </CardHeader>
      <CardContent>
        {/* Its own scroll container: the page body must never scroll sideways. */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted-foreground border-b text-left text-xs uppercase tracking-wide">
                <th className="pb-2 pr-4 font-medium">Cause</th>
                <th className="pb-2 pr-4 text-right font-medium">Cases</th>
                <th className="pb-2 pr-4 text-right font-medium">At risk</th>
                <th className="pb-2 text-right font-medium">Recovered</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {causes.map((c) => (
                <tr key={c.reason}>
                  <td className="py-2.5 pr-4">{c.label}</td>
                  <td className="py-2.5 pr-4 text-right tabular-nums">{c.events}</td>
                  <td className="py-2.5 pr-4 text-right tabular-nums">
                    {formatINR(c.amount_at_risk)}
                  </td>
                  <td className="py-2.5 text-right tabular-nums">
                    <span className="font-semibold">{c.rate.toFixed(0)}%</span>
                    <span className="text-muted-foreground ml-2 text-xs">
                      {c.recovered}/{c.events}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

/* ── did it behave ───────────────────────────────────────────────────────── */

function InvariantRow({ inv }: { inv: Invariant }) {
  return (
    <div className="flex items-start gap-3 py-3">
      {inv.held ? (
        <CircleCheckIcon
          className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
          aria-hidden="true"
        />
      ) : (
        <TriangleAlertIcon
          className="mt-0.5 size-4 shrink-0 text-red-600 dark:text-red-400"
          aria-hidden="true"
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm">{inv.claim}</span>
        {!inv.held && (
          <span className="mt-0.5 text-xs text-red-600 dark:text-red-400">
            {inv.breaches} {inv.breach}
          </span>
        )}
      </div>
      <span className="sr-only">{inv.held ? "held" : "breached"}</span>
    </div>
  );
}

function RulesCard({ invariants }: { invariants: Invariant[] }) {
  const broken = invariants.filter((i) => !i.held).length;
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Every rule, checked against your data</CardTitle>
          <Badge
            variant="outline"
            className={cn(
              broken === 0
                ? "border-emerald-500 text-emerald-600 dark:text-emerald-400"
                : "border-red-500 text-red-600 dark:text-red-400",
            )}
          >
            {broken === 0 ? "All held" : `${broken} broken`}
          </Badge>
        </div>
        <p className="text-muted-foreground text-sm">
          Run against the rows themselves, not against anything the agent
          recorded about its own behaviour — an agent reporting a clean week is
          exactly what a bug in it would also produce.
        </p>
      </CardHeader>
      <CardContent>
        <div className="divide-y">
          {invariants.map((i) => (
            <InvariantRow key={i.id} inv={i} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * When messages actually went out, against the window you promised.
 *
 * Drawn to one scale across all twenty-four hours, including the empty ones -
 * the silent hours are the entire point. A chart of only the hours we sent in
 * cannot show that nothing went at three in the morning.
 */
function WindowCard({
  hours, window, timezone, breaches,
}: {
  hours: SendHour[];
  window: { start: string; end: string };
  timezone: string;
  /**
   * Breaches from the invariant, which compares each send's own timestamp.
   * The chart cannot answer this itself - an hour-wide bucket straddles the
   * edge of the window - and a chart that guesses next to a check that knows
   * is how this page ended up printing two different answers at once.
   */
  breaches: number;
}) {
  const peak = Math.max(1, ...hours.map((h) => h.sends));

  return (
    <Card>
      <CardHeader>
        <CardTitle>When messages actually went out</CardTitle>
        <p className="text-muted-foreground text-sm">
          Local hours in {timezone}. The shaded band is your contact window,{" "}
          {window.start.slice(0, 5)}–{window.end.slice(0, 5)}.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="overflow-x-auto">
          <div className="flex min-w-[34rem] items-end gap-[3px]" role="img"
               aria-label={`Messages sent by hour of day in ${timezone}`}>
            {hours.map((h) => (
              <div key={h.hour} className="flex flex-1 flex-col items-center gap-1">
                <span className="text-muted-foreground text-[0.6rem] tabular-nums">
                  {h.sends > 0 ? h.sends : ""}
                </span>
                <div
                  className={cn(
                    "w-full rounded-sm",
                    h.sends === 0
                      ? "bg-muted"
                      : h.inWindow
                        ? "bg-emerald-500"
                        : "bg-red-500",
                  )}
                  // Floor of 2px so an hour with no sends still draws a
                  // baseline; a gap in the row reads as missing data.
                  style={{ height: `${Math.max(2, (h.sends / peak) * 72)}px` }}
                />
                <span
                  className={cn(
                    "text-[0.6rem] tabular-nums",
                    h.inWindow ? "text-foreground font-medium" : "text-muted-foreground",
                  )}
                >
                  {String(h.hour).padStart(2, "0")}
                </span>
              </div>
            ))}
          </div>
        </div>

        <p className="text-sm">
          {breaches === 0 ? (
            <span className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
              <CircleCheckIcon className="size-4 shrink-0" aria-hidden="true" />
              Every message landed inside the window.
            </span>
          ) : (
            <span className="flex items-center gap-2 text-red-600 dark:text-red-400">
              <TriangleAlertIcon className="size-4 shrink-0" aria-hidden="true" />
              {breaches} message{breaches === 1 ? "" : "s"} landed outside it.
            </span>
          )}
        </p>
      </CardContent>
    </Card>
  );
}

/* ── the page ────────────────────────────────────────────────────────────── */

export function Evidence({
  lift, spend, causes, invariants, hours, window, timezone,
}: {
  lift: Lift;
  spend: Spend;
  causes: CausePerformance[];
  invariants: Invariant[];
  hours: SendHour[];
  window: { start: string; end: string };
  timezone: string;
}) {
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold tracking-tight">Did it work?</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          <LiftCard lift={lift} />
          <SpendCard
            spend={spend}
            recovered={
              lift.contacted.amount_recovered + (lift.control?.amount_recovered ?? 0)
            }
          />
        </div>
        <CausesCard causes={causes} />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold tracking-tight">Did it behave?</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          <RulesCard invariants={invariants} />
          <WindowCard
            hours={hours}
            window={window}
            timezone={timezone}
            breaches={
              invariants.find((i) => i.id === "contact_window")?.breaches ?? 0
            }
          />
        </div>
      </section>
    </div>
  );
}
