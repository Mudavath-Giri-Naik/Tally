"use client";

/**
 * The Features section, as a bento grid.
 *
 * Shaped after shadcn's own bento-grid-1 block - one tall lead cell, a pair
 * of regular cells beside it, then two wide cells beneath - but built from
 * this project's own Card primitive and the six real FEATURE_CARDS entries
 * page.tsx defines, rather than the block's placeholder images and lorem-ish
 * copy. Explicit grid-column/row placement throughout instead of relying on
 * auto-flow packing: a bento's whole appeal is a specific silhouette, and
 * that only stays exact if every cell says where it goes.
 *
 * A client component only for the one thing that genuinely needs the
 * browser: the spotlight tracks the pointer, so each card's own glow follows
 * where someone is actually looking rather than sitting in a fixed corner.
 * Everything else - the entrance, the icon's ambient float, the border glow -
 * is CSS that would run identically without a line of JS, and stays that way.
 *
 * FEATURE_CARDS lives here rather than in page.tsx for a reason that is not
 * stylistic: a Server Component can pass a Client Component pre-rendered
 * JSX, but not a bare function reference like a Lucide icon component - React
 * cannot serialise a function across that boundary, and page.tsx handing
 * this file an array containing SendIcon, ClockIcon and the rest failed at
 * runtime with exactly that error. Once the data lives inside the Client
 * Component that renders it, there is no boundary for the icons to cross.
 */
import { useRef } from "react";
import {
  ClockIcon,
  EyeIcon,
  GitMergeIcon,
  LockKeyholeIcon,
  OctagonXIcon,
  SendIcon,
} from "lucide-react";

interface FeatureCard {
  t: string;
  d: string;
  // Lucide's own prop shape, not a narrowed { className } - the background
  // watermark below needs to pass a style prop too, for its tone colour.
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  tone: Tone;
}

const FEATURE_CARDS: FeatureCard[] = [
  {
    t: "Acts, rather than labels",
    d: "It sends the message, places the call, and generates the retry link — inside the guardrails you set.",
    icon: SendIcon,
    tone: "violet",
  },
  {
    t: "Respects your rules",
    d: "A contact window, an attempt cap, and an instant stop on opt-out. A message that would land at 2am waits until morning.",
    icon: ClockIcon,
    tone: "sky",
  },
  {
    t: "One message, not three",
    d: "If a customer has a failed subscription and an abandoned cart, they hear from you once, about both.",
    icon: GitMergeIcon,
    tone: "amber",
  },
  {
    t: "Knows when to stop",
    d: "After a few failed cycles, or anything flagged by risk checks, it stops automating and hands over to a person.",
    icon: OctagonXIcon,
    tone: "rose",
  },
  {
    t: "Shows its reasoning",
    d: "Every action records why it was taken, which rule fired, and what was sent. Nothing happens off the record.",
    icon: EyeIcon,
    tone: "indigo",
  },
  {
    t: "Your keys, your customers",
    d: "Your Razorpay credentials are encrypted per business and used only to act for you. Merchants are isolated from each other.",
    icon: LockKeyholeIcon,
    tone: "emerald",
  },
];

type Tone = "violet" | "sky" | "amber" | "rose" | "indigo" | "emerald";

/**
 * Every colour a card needs, in one place, as full literal strings -
 * Tailwind scans source text for class names and cannot find one built at
 * runtime, so a tone assembled from a template string would silently render
 * as nothing. `glow` is the one raw value here, because a CSS radial-gradient
 * position has to be computed from the live cursor and cannot be a class.
 */
const TONES: Record<
  Tone,
  { chip: string; border: string; title: string; glow: string }
> = {
  violet: {
    chip: "bg-violet-50 text-violet-600 dark:bg-violet-500/10",
    border: "hover:border-violet-300",
    title: "group-hover:text-violet-700",
    glow: "139,92,246",
  },
  sky: {
    chip: "bg-sky-50 text-sky-600 dark:bg-sky-500/10",
    border: "hover:border-sky-300",
    title: "group-hover:text-sky-700",
    glow: "14,165,233",
  },
  amber: {
    chip: "bg-amber-50 text-amber-600 dark:bg-amber-500/10",
    border: "hover:border-amber-300",
    title: "group-hover:text-amber-700",
    glow: "245,158,11",
  },
  rose: {
    chip: "bg-rose-50 text-rose-600 dark:bg-rose-500/10",
    border: "hover:border-rose-300",
    title: "group-hover:text-rose-700",
    glow: "244,63,94",
  },
  indigo: {
    chip: "bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10",
    border: "hover:border-indigo-300",
    title: "group-hover:text-indigo-700",
    glow: "99,102,241",
  },
  emerald: {
    chip: "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10",
    border: "hover:border-emerald-300",
    title: "group-hover:text-emerald-700",
    glow: "16,185,129",
  },
};

type Shape = "lead" | "tall" | "wide" | "regular";

/** Where each of the six cards sits in the 3-column, 3-row template. */
const PLACEMENT: Array<{ shape: Shape; className: string }> = [
  { shape: "lead", className: "lg:col-start-1 lg:row-start-1 lg:row-span-2" },
  { shape: "tall", className: "lg:col-start-2 lg:row-start-1" },
  { shape: "tall", className: "lg:col-start-3 lg:row-start-1" },
  { shape: "wide", className: "lg:col-start-2 lg:col-span-2 lg:row-start-2" },
  { shape: "regular", className: "lg:col-start-1 lg:row-start-3" },
  { shape: "wide", className: "lg:col-start-2 lg:col-span-2 lg:row-start-3" },
];

function FeatureCell({
  card, shape, className, delayMs,
}: {
  card: FeatureCard;
  shape: Shape;
  className: string;
  delayMs: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const Icon = card.icon;
  const t = TONES[card.tone];
  const horizontal = shape === "wide";
  const isLead = shape === "lead";

  /** The spotlight follows the pointer within this one card - each card
   *  tracks its own, so hovering the lead cell never lights up its neighbour. */
  function onMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    ref.current!.style.setProperty("--mx", `${e.clientX - box.left}px`);
    ref.current!.style.setProperty("--my", `${e.clientY - box.top}px`);
  }

  return (
    <div
      ref={ref}
      onMouseMove={onMouseMove}
      className={`marketing-motion group relative overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm transition-all duration-300 hover:-translate-y-1.5 hover:shadow-2xl ${t.border} ${className}`}
      style={{
        animation: `fade-up 0.6s cubic-bezier(0.16,1,0.3,1) both`,
        animationDelay: `${delayMs}ms`,
        boxShadow: `0 0 0 1px transparent`,
      }}
    >
      {/* A held-back glow, sized to the card and coloured to its tone, that
          only shows once the border does - keeps six live gradients from all
          fighting for attention on load. */}
      <span
        className="pointer-events-none absolute -inset-px rounded-2xl opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          background: `radial-gradient(160px circle at var(--mx, 50%) var(--my, 0%), rgba(${t.glow},0.16), transparent 70%)`,
        }}
        aria-hidden="true"
      />

      {/* An oversized, near-invisible copy of the card's own icon, bleeding
          off the corner - texture rather than information, the way a real
          bento card earns the empty space around its headline. */}
      <Icon
        className="pointer-events-none absolute -right-6 -bottom-8 size-32 rotate-[-8deg] text-current opacity-[0.05] transition-transform duration-500 group-hover:rotate-0 group-hover:scale-110 sm:size-40"
        style={{ color: `rgb(${t.glow})` }}
        aria-hidden="true"
      />

      <div
        className={`relative flex h-full flex-col justify-center gap-4 p-6 ${
          horizontal ? "sm:flex-row sm:items-center sm:gap-6" : ""
        } ${isLead ? "sm:p-8" : ""}`}
      >
        <span className="relative inline-flex shrink-0">
          {/* The halo breathes on its own, at rest - the one piece of motion
              that never waits for a hover to prove the card is alive. */}
          <span
            className="animate-node-pulse absolute inset-0 rounded-xl"
            style={{ "--pulse-color": `rgba(${t.glow},0.4)` } as React.CSSProperties}
            aria-hidden="true"
          />
          <span
            className={`animate-float relative flex items-center justify-center rounded-xl shadow-sm transition-transform duration-300 group-hover:scale-110 group-hover:-rotate-6 ${
              isLead ? "size-14" : "size-11"
            } ${t.chip}`}
          >
            <Icon className={isLead ? "size-7" : "size-5"} />
          </span>
        </span>

        <div className="min-w-0">
          <h3
            className={`font-semibold text-neutral-900 transition-colors duration-300 ${t.title} ${
              isLead ? "text-lg" : ""
            }`}
          >
            {card.t}
          </h3>
          <p className={`mt-2 text-neutral-600 ${isLead ? "text-sm sm:text-base" : "text-sm"}`}>
            {card.d}
          </p>
        </div>
      </div>
    </div>
  );
}

export function FeaturesBento() {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:grid-rows-[repeat(3,minmax(0,1fr))]">
      {FEATURE_CARDS.map((card, i) => {
        const p = PLACEMENT[i];
        if (!p) return null;
        return (
          <FeatureCell
            key={card.t}
            card={card}
            shape={p.shape}
            className={p.className}
            delayMs={i * 90}
          />
        );
      })}
    </div>
  );
}
