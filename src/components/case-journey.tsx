"use client";

/**
 * The live progress strip at the top of a case.
 *
 * Deliberately not another set of timeline cards. Cards are for reading; this
 * is for glancing - a numbered ladder where the eye lands on the one row that
 * is moving. Every row is the same height and the same shape, so scanning down
 * the status column is the fastest way to answer "where is this".
 *
 * The panel already refetches every four seconds, so this redraws on its own
 * as the worker moves the case along. Nothing here holds state or polls.
 */
import { ChevronDownIcon } from "lucide-react";

import type { JourneyStep, StepState } from "@/lib/journey";
import { journeyProgress } from "@/lib/journey";
import { cn } from "@/lib/utils";

/**
 * One palette per state, used for the chip, the number and the rail together,
 * so a row reads as a single object rather than three coloured pieces.
 *
 * Full literal class strings on purpose - Tailwind scans source text and
 * cannot find a class assembled at runtime.
 */
const STATE_STYLE: Record<
  StepState,
  { chip: string; dot: string; rail: string; label: string }
> = {
  done: {
    chip: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
    dot: "bg-emerald-500 text-white",
    rail: "bg-emerald-500/30",
    label: "done",
  },
  active: {
    chip: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/40",
    dot: "bg-amber-500 text-white",
    rail: "bg-amber-500/30",
    label: "happening now",
  },
  waiting: {
    chip: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/30",
    dot: "bg-blue-500 text-white",
    rail: "bg-blue-500/30",
    label: "waiting",
  },
  failed: {
    chip: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/30",
    dot: "bg-red-500 text-white",
    rail: "bg-red-500/30",
    label: "failed",
  },
  skipped: {
    chip: "bg-slate-500/10 text-slate-700 dark:text-slate-300 border-slate-500/30",
    dot: "bg-slate-500 text-white",
    rail: "bg-slate-500/30",
    label: "stopped",
  },
  pending: {
    chip: "bg-muted text-muted-foreground border-border",
    dot: "bg-muted text-muted-foreground",
    rail: "bg-border",
    label: "not yet",
  },
};

/** Local wall-clock, no date - the strip is about today. */
function stamp(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Row({ step, isLast }: { step: JourneyStep; isLast: boolean }) {
  const s = STATE_STYLE[step.state];
  const live = step.state === "active";

  return (
    <li className="relative flex gap-3">
      {/* The rail, drawn behind the number and stopping at the last row. */}
      {!isLast && (
        <span
          aria-hidden="true"
          className={cn("absolute left-[11px] top-6 h-[calc(100%-0.5rem)] w-px", s.rail)}
        />
      )}

      <span
        className={cn(
          "relative z-10 mt-0.5 flex size-[22px] shrink-0 items-center justify-center rounded-full text-[0.65rem] font-bold tabular-nums",
          s.dot,
        )}
      >
        {step.n}
        {/* A single quiet pulse on the one row that is moving. Respects
            prefers-reduced-motion through Tailwind's motion-safe variant. */}
        {live && (
          <span
            aria-hidden="true"
            className="motion-safe:animate-ping absolute inset-0 rounded-full bg-amber-500 opacity-60"
          />
        )}
      </span>

      <div className="min-w-0 flex-1 pb-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span
            className={cn(
              "text-sm leading-tight",
              step.state === "pending" ? "text-muted-foreground" : "font-medium",
            )}
          >
            {step.title}
          </span>
          <span
            className={cn(
              "rounded border px-1.5 py-px font-mono text-[0.6rem] font-bold tracking-wide uppercase",
              s.chip,
            )}
          >
            {step.code}
          </span>
          {step.at && (
            <span className="text-muted-foreground ml-auto shrink-0 text-[0.65rem] tabular-nums">
              {stamp(step.at)}
            </span>
          )}
          <span className="sr-only">{s.label}</span>
        </div>

        {step.detail && (
          <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed break-words">
            {step.detail}
          </p>
        )}
      </div>
    </li>
  );
}

export function CaseJourney({ steps }: { steps: JourneyStep[] }) {
  if (steps.length === 0) return null;
  const { done, total } = journeyProgress(steps);
  const current = steps.find((s) => s.state === "active" || s.state === "waiting");

  return (
    <details open className="group mb-5 rounded-lg border">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 select-none">
        <ChevronDownIcon
          className="text-muted-foreground size-4 shrink-0 transition-transform group-open:rotate-0 -rotate-90"
          aria-hidden="true"
        />
        <span className="text-sm font-semibold">Live progress</span>

        {/* What is happening, right in the header - so a collapsed strip still
            answers the question the strip exists to answer. */}
        {current && (
          <span
            className={cn(
              "rounded border px-1.5 py-px font-mono text-[0.6rem] font-bold tracking-wide uppercase",
              STATE_STYLE[current.state].chip,
            )}
          >
            {current.code}
          </span>
        )}

        <span className="text-muted-foreground ml-auto shrink-0 text-[0.7rem] tabular-nums">
          {done}/{total} steps
        </span>
      </summary>

      <div className="border-t px-3 py-3">
        <ol className="flex flex-col">
          {steps.map((step, i) => (
            <Row key={step.n} step={step} isLast={i === steps.length - 1} />
          ))}
        </ol>
      </div>
    </details>
  );
}
