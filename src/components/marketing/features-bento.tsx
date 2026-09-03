/**
 * The Features section, as a bento grid.
 *
 * Shaped after shadcn's own bento-grid-1 block - one tall lead cell, a pair
 * of regular cells beside it, then two wide cells beneath - but built from
 * this project's own Card primitive and the six real FEATURE_CARDS entries
 * page.tsx already defines, rather than the block's placeholder images and
 * lorem-ish copy. Explicit grid-column/row placement throughout instead of
 * relying on auto-flow packing: a bento's whole appeal is a specific
 * silhouette, and that only stays exact if every cell says where it goes.
 *
 * Nine cells, three shapes, zero gaps:
 *
 *   ┌────────┬────────┬────────┐
 *   │        │  tall  │  tall  │
 *   │  lead  ├────────┴────────┤
 *   │ (tall) │       wide      │
 *   ├────────┼─────────────────┤
 *   │ regular│       wide      │
 *   └────────┴─────────────────┘
 *
 * A pure server component - the colour and the motion are all CSS.
 */
import { Card, CardContent } from "@/components/ui/card";

export interface FeatureCard {
  t: string;
  d: string;
  icon: React.ComponentType<{ className?: string }>;
  chip: string;
  bar: string;
}

type Shape = "lead" | "tall" | "wide" | "regular";

/** Where each of the six cards sits in the 3-column, 3-row template above. */
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
  const Icon = card.icon;
  const horizontal = shape === "wide";
  const iconSize = shape === "lead" ? "size-14" : "size-11";
  const iconInnerSize = shape === "lead" ? "size-7" : "size-5";

  return (
    <Card
      className={`animate-fade-up marketing-motion group relative gap-0 overflow-hidden rounded-2xl border-neutral-200 py-0 shadow-sm transition hover:-translate-y-1 hover:shadow-xl ${className}`}
      style={{ animationDelay: `${delayMs}ms` }}
    >
      <span
        className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${card.bar}`}
        aria-hidden="true"
      />
      <CardContent
        className={`flex h-full flex-col justify-center gap-4 p-6 ${
          horizontal ? "sm:flex-row sm:items-center sm:gap-6" : ""
        } ${shape === "lead" ? "sm:p-8" : ""}`}
      >
        <span
          className={`flex shrink-0 items-center justify-center rounded-xl transition-transform duration-300 group-hover:scale-110 ${iconSize} ${card.chip}`}
        >
          <Icon className={iconInnerSize} />
        </span>
        <div>
          <h3 className={shape === "lead" ? "text-lg font-semibold text-neutral-900" : "font-semibold text-neutral-900"}>
            {card.t}
          </h3>
          <p className={`mt-2 text-neutral-600 ${shape === "lead" ? "text-sm sm:text-base" : "text-sm"}`}>
            {card.d}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export function FeaturesBento({ cards }: { cards: FeatureCard[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:grid-rows-[repeat(3,minmax(0,1fr))]">
      {cards.map((card, i) => {
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
