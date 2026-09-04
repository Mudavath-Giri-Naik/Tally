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
  CircleHelpIcon,
  ClockIcon,
  ShieldCheckIcon,
  SparklesIcon,
  TrendingDownIcon,
  TrendingUpIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { formatINR } from "@/lib/types";
import { RANGES, formatDuration, type Dashboard } from "@/lib/board";
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

/**
 * One accent per tile, and the accent is semantic rather than decorative:
 * green is money returning, amber is a queue with people in it, violet is the
 * agent's own work.
 *
 * `track` is a diagonal hatch in the tile's own hue rather than a flat tint -
 * it reads as "the room left to fill" the way a ceiling does, instead of a
 * plain bar that could as easily be a loading skeleton. Full literal strings
 * throughout, tone by tone: Tailwind scans source text for class names and
 * cannot find one built at runtime, so a computed `bg-[...]` would silently
 * render as nothing.
 */
const TONES = {
  emerald: {
    value: "text-emerald-600 dark:text-emerald-400",
    chip: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    bar: "bg-emerald-500",
    track:
      "bg-[repeating-linear-gradient(135deg,rgba(16,185,129,0.16)_0px,rgba(16,185,129,0.16)_3px,transparent_3px,transparent_7px)] dark:bg-[repeating-linear-gradient(135deg,rgba(52,211,153,0.22)_0px,rgba(52,211,153,0.22)_3px,transparent_3px,transparent_7px)]",
  },
  amber: {
    value: "text-amber-600 dark:text-amber-400",
    chip: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    bar: "bg-amber-500",
    track:
      "bg-[repeating-linear-gradient(135deg,rgba(245,158,11,0.16)_0px,rgba(245,158,11,0.16)_3px,transparent_3px,transparent_7px)] dark:bg-[repeating-linear-gradient(135deg,rgba(251,191,36,0.22)_0px,rgba(251,191,36,0.22)_3px,transparent_3px,transparent_7px)]",
  },
  violet: {
    value: "text-violet-600 dark:text-violet-400",
    chip: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
    bar: "bg-violet-500",
    track:
      "bg-[repeating-linear-gradient(135deg,rgba(139,92,246,0.16)_0px,rgba(139,92,246,0.16)_3px,transparent_3px,transparent_7px)] dark:bg-[repeating-linear-gradient(135deg,rgba(167,139,250,0.22)_0px,rgba(167,139,250,0.22)_3px,transparent_3px,transparent_7px)]",
  },
  sky: {
    value: "text-sky-600 dark:text-sky-400",
    chip: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
    bar: "bg-sky-500",
    track:
      "bg-[repeating-linear-gradient(135deg,rgba(14,165,233,0.16)_0px,rgba(14,165,233,0.16)_3px,transparent_3px,transparent_7px)] dark:bg-[repeating-linear-gradient(135deg,rgba(56,189,248,0.22)_0px,rgba(56,189,248,0.22)_3px,transparent_3px,transparent_7px)]",
  },
  indigo: {
    value: "text-indigo-600 dark:text-indigo-400",
    chip: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
    bar: "bg-indigo-500",
    track:
      "bg-[repeating-linear-gradient(135deg,rgba(99,102,241,0.16)_0px,rgba(99,102,241,0.16)_3px,transparent_3px,transparent_7px)] dark:bg-[repeating-linear-gradient(135deg,rgba(129,140,248,0.22)_0px,rgba(129,140,248,0.22)_3px,transparent_3px,transparent_7px)]",
  },
  slate: {
    value: "text-slate-700 dark:text-slate-200",
    chip: "bg-slate-500/10 text-slate-600 dark:text-slate-300",
    bar: "bg-slate-500",
    track:
      "bg-[repeating-linear-gradient(135deg,rgba(100,116,139,0.16)_0px,rgba(100,116,139,0.16)_3px,transparent_3px,transparent_7px)] dark:bg-[repeating-linear-gradient(135deg,rgba(148,163,184,0.22)_0px,rgba(148,163,184,0.22)_3px,transparent_3px,transparent_7px)]",
  },
} as const;

type Tone = keyof typeof TONES;

/** The tile's bullet: an icon in a softly tinted circle of its own tone,
 *  rather than an abstract gauge - a glance should tell you what kind of
 *  thing this tile is about before it tells you how full it is. */
function IconBullet({
  icon: Icon, tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  tone: Tone;
}) {
  return (
    <span
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-full",
        TONES[tone].chip,
      )}
    >
      <Icon className="size-3.5" />
    </span>
  );
}

/**
 * A row of ticks rather than a smooth fill, each one lit in the tile's own
 * tone up to the share it stands for and left plain beyond it.
 *
 * Reads at a glance the way a signal-strength meter does, and stays legible
 * at the narrow width these tiles have to work with - a hairline smooth bar
 * at this size reads as a loading skeleton as easily as it reads as a
 * finished number.
 */
function SegmentedBar({
  tone, percent, segments = 10,
}: {
  tone: Tone;
  percent: number;
  segments?: number;
}) {
  const pct = Math.min(100, Math.max(0, percent));
  const lit = Math.round((pct / 100) * segments);
  return (
    <div
      className="flex h-4 items-stretch gap-[3px]"
      role="img"
      aria-label={`${Math.round(pct)} percent`}
    >
      {Array.from({ length: segments }, (_, i) => (
        // Sharp rectangles, not pills - upright bars read as a meter; rounded
        // caps at this width start to look like a row of dots instead.
        <span
          key={i}
          className={cn("bg-muted h-full flex-1", i < lit && TONES[tone].bar)}
        />
      ))}
    </div>
  );
}

/** The line every tile opens with: bullet, label, and an optional one-line
 *  explanation for a label that is not self-explanatory on first read. */
function TileHead({
  label, bullet, help,
}: {
  label: string;
  bullet: React.ReactNode;
  help?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      {bullet}
      <span className="text-muted-foreground min-w-0 truncate text-[0.7rem] font-medium">
        {label}
      </span>
      {help && (
        <span title={help} className="shrink-0">
          <CircleHelpIcon className="text-muted-foreground/50 size-3" aria-hidden="true" />
        </span>
      )}
    </div>
  );
}

/**
 * "down from 14%" - stated as a sentence rather than a bare arrow-and-number
 * badge, so the direction and what it moved from are both legible without
 * the reader having to already know what the previous period looked like.
 */
function CompareLine({
  now, previous, riseIsGood = true, format,
}: {
  now: number;
  previous: number | null | undefined;
  riseIsGood?: boolean;
  format: (n: number) => string;
}) {
  if (previous === null || previous === undefined || now === previous) return null;
  const rising = now > previous;
  const good = rising === riseIsGood;
  return (
    <p
      className={cn(
        "flex items-center gap-1 text-[0.68rem] font-semibold",
        good ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400",
      )}
    >
      <span aria-hidden="true">{rising ? "↗" : "↘"}</span>
      {rising ? "up" : "down"} from {format(previous)}
    </p>
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
      <div className={cn("relative h-1.5 w-full overflow-hidden rounded-full", TONES[tone].track)}>
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
  label, bullet, help, tone, value, unit, compare, detail, fill, footer,
}: {
  label: string;
  bullet: React.ReactNode;
  help?: string;
  tone: Tone;
  value: string;
  /** Sits on the number's baseline - "%" or "cases", never part of the value. */
  unit?: string;
  /** The sentence under the number - "up from X", "down from X". Omitted
   *  entirely when there is nothing to compare against yet. */
  compare?: {
    now: number;
    previous: number | null | undefined;
    riseIsGood?: boolean;
    format: (n: number) => string;
  };
  detail: React.ReactNode;
  /** 0-100. The bar is the tile's proof; a tile with no honest proportion
   *  to show gets none rather than a decorative one. */
  fill?: number;
  /** Sits where the bar would, for a tile whose proof is not a proportion. */
  footer?: React.ReactNode;
}) {
  const t = TONES[tone];
  return (
    <Card size="sm" className="gap-0">
      <CardContent className="flex flex-col gap-1.5 px-3">
        <TileHead label={label} bullet={bullet} help={help} />

        <div className="flex items-baseline gap-1">
          <span className={cn("text-2xl font-bold tracking-tight tabular-nums", t.value)}>
            {value}
          </span>
          {unit && <span className="text-muted-foreground text-xs font-medium">{unit}</span>}
        </div>

        {compare && <CompareLine {...compare} />}

        <p className="text-muted-foreground text-[0.7rem] leading-snug">{detail}</p>

        {/* Anchored to the card's bottom edge with mt-auto rather than
            following straight after the text. Detail (and now the compare
            line) runs to different lengths tile to tile, so the proof block
            used to land at whatever height the text happened to leave it -
            every tile fills evenly now, with the leftover space collected
            above the divider instead of showing up as air underneath it. */}
        {(fill !== undefined || footer) && (
          <div className="mt-auto flex flex-col gap-1.5 pt-1.5">
            <div className="border-t" />
            {fill !== undefined && <SegmentedBar tone={tone} percent={fill} />}
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
      <CardContent className="flex flex-col gap-1.5 px-3">
        <TileHead label="Top causes" bullet={<IconBullet icon={TrendingUpIcon} tone="slate" />} />

        <div className="border-t pt-1.5">
          {causes.length === 0 ? (
            <p className="text-muted-foreground py-2 text-[0.7rem]">
              No open failures here.
            </p>
          ) : (
            <ul className="flex flex-col">
              {causes.map((c) => {
                const before = previous.find((p) => p.reason === c.reason);
                // A cause missing from the previous window's top three might
                // be new or might have been just below the cut - unknowable
                // from here. It gets a dot, because guessing an arrow would
                // be inventing a trend out of a reporting limit.
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
                    className="flex items-center gap-2 border-b py-1 text-[0.7rem] last:border-b-0"
                  >
                    <span
                      className="bg-muted-foreground/40 size-1.5 shrink-0 rounded-full"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate" title={c.label}>{c.label}</span>
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
            <p className="text-muted-foreground mt-1 text-[0.6rem] leading-snug">
              No earlier period to compare
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function Customers({
  slug, initial, openEvent,
}: {
  slug: string;
  initial: Dashboard;
  /** A case to open on arrival - the Inbox tab deep-links here with one. */
  openEvent?: string | null;
}) {
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

  // The three ring percentages, computed once rather than inline twice each -
  // the bullet and the fill bar below it have to show the exact same number,
  // or the tile is illustrating one fact with a picture of another.
  const needsPct =
    data.metrics.total_events > 0 ? (needsAttention / data.metrics.total_events) * 100 : 0;
  const autoPct =
    data.metrics.sent_total > 0
      ? (data.metrics.sent_in_window / data.metrics.sent_total) * 100
      : 0;
  const guardPct =
    data.metrics.total_actions > 0
      ? (data.metrics.guardrail_actions / data.metrics.total_actions) * 100
      : 0;
  const needsTone = needsAttention > 0 ? "amber" : "emerald";

  // Whether there is an earlier window at all to compare against - not
  // whether any single figure in it happened to be zero. A previous period
  // with no events at all makes every metric read as 0, and "up from 0%"
  // over that is a different claim from an honest "there is nothing to
  // compare against yet" - the same distinction MomentumTile already draws
  // for the causes list, applied here to every other tile's own comparison.
  const hasPriorPeriod = data.previous.total_events > 0;

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
          Six tiles, one row. Each headline number gets a small ring gauge
          reading its own share, a plain comparison sentence against the
          period before it, and the proof underneath drawn to the same
          number the ring shows - three places to look, one fact to find. */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatTile
          label="Recovery"
          bullet={<IconBullet icon={TrendingUpIcon} tone="emerald" />}
          tone="emerald"
          value={`${data.metrics.recovery_rate}%`}
          compare={
            hasPriorPeriod
              ? {
                  now: data.metrics.recovery_rate,
                  previous: data.previous.recovery_rate,
                  format: (n) => `${n}%`,
                }
              : undefined
          }
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
        />

        <StatTile
          label="Needs attention"
          help="Cases where the agent stopped and a person has to decide what happens next."
          bullet={<IconBullet icon={TriangleAlertIcon} tone={needsTone} />}
          tone={needsTone}
          value={String(needsAttention)}
          unit={needsAttention === 1 ? "case" : "cases"}
          compare={
            hasPriorPeriod
              ? {
                  now: needsAttention,
                  previous: data.previous.needs_human,
                  riseIsGood: false,
                  format: (n) => `${n} last period`,
                }
              : undefined
          }
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
          fill={needsPct}
        />

        <StatTile
          label="Automation"
          bullet={<IconBullet icon={SparklesIcon} tone="violet" />}
          tone="violet"
          value={String(data.metrics.sent_total)}
          unit={data.metrics.sent_total === 1 ? "action" : "actions"}
          compare={
            hasPriorPeriod
              ? {
                  now: data.metrics.sent_total,
                  previous: data.previous.sent_total,
                  format: (n) => `${n} last period`,
                }
              : undefined
          }
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
          // The compliance fraction already named in the sentence above,
          // drawn as well as said - what a merchant is actually answerable
          // for is the share inside the window, not the raw count sent.
          fill={autoPct}
        />

        <StatTile
          label="Avg recovery"
          bullet={<IconBullet icon={ClockIcon} tone="sky" />}
          tone="sky"
          value={avg === null ? "—" : formatDuration(avg)}
          compare={
            avg !== null && hasPriorPeriod
              ? {
                  now: avg,
                  previous: data.previous.avg_recovery_seconds,
                  // Slower is worse, so a rise is bad news here.
                  riseIsGood: false,
                  format: formatDuration,
                }
              : undefined
          }
          // Only shown once there is something recovered to have an opinion
          // about - "Nothing recovered yet" already covers the other case,
          // and stacking a second empty-state note on top of it would say
          // the same absence twice.
          detail={avg === null ? "Nothing recovered yet" : "failure to payment"}
          footer={
            avg !== null && fastest !== null && slowest !== null ? (
              <RangeTrack tone="sky" fastest={fastest} slowest={slowest} value={avg} />
            ) : undefined
          }
        />

        <StatTile
          label="Guardrails"
          help="How often a fixed rule overruled or adjusted what the model wanted to do."
          bullet={<IconBullet icon={ShieldCheckIcon} tone="indigo" />}
          tone="indigo"
          value={String(data.metrics.guardrail_actions)}
          unit={data.metrics.guardrail_actions === 1 ? "action" : "actions"}
          compare={
            hasPriorPeriod
              ? {
                  now: data.metrics.guardrail_actions,
                  previous: data.previous.guardrail_actions,
                  riseIsGood: false,
                  format: (n) => `${n} last period`,
                }
              : undefined
          }
          detail={
            data.metrics.total_actions > 0 ? (
              <>of {data.metrics.total_actions} decisions · rule overrode the model</>
            ) : (
              <>rule overrode the model</>
            )
          }
          // Share of every decision this window where a rule, not the model,
          // had the final word - the figure that actually backs up "the agent
          // proposes, the guardrails dispose" instead of just asserting it.
          fill={guardPct}
        />

        <MomentumTile
          causes={data.metrics.top_causes}
          previous={data.previous.top_causes}
        />
      </div>

      {/* Said once here rather than inside every tile that is missing a
          comparison - the same sentence repeated six times down the row was
          noisier than the six blank spaces it was replacing. */}
      {!hasPriorPeriod && (
        <p className="text-muted-foreground -mt-3 text-xs">
          Comparisons against the previous period will appear once one has passed.
        </p>
      )}

      <CaseBoard slug={slug} data={data} setData={setData} initialOpenEvent={openEvent} />
    </div>
  );
}
