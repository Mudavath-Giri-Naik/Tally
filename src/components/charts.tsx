"use client";

/**
 * The dashboard's charts.
 *
 * Hand-drawn SVG rather than a charting dependency: there are three forms on
 * the page, they all take their colour from the theme's tokens, and a library
 * would be larger than the code below.
 */
import { useState } from "react";
import { formatINR } from "@/lib/types";

/* ── sparkline ───────────────────────────────────────────────────────────── */

/**
 * The line inside a metric card. No axes, no labels - it exists to show shape,
 * and the number above it carries the value.
 *
 * A flat series still gets a line through the middle rather than along the
 * floor, because a run of zeroes drawn at the baseline reads as missing data.
 */
export function Sparkline({
  values,
  tone,
  height = 34,
}: {
  values: number[];
  tone: string;
  height?: number;
}) {
  if (values.length === 0) return <div className="spark" style={{ height }} />;

  const W = 100;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min;
  const step = values.length > 1 ? W / (values.length - 1) : W;

  const y = (v: number) =>
    span === 0 ? height / 2 : height - 3 - ((v - min) / span) * (height - 6);

  const points = values.map((v, i) => `${i * step},${y(v)}`);
  const line = `M${points.join(" L")}`;
  const area = `${line} L${W},${height} L0,${height} Z`;

  return (
    <svg
      className={`spark spark--${tone}`}
      viewBox={`0 0 ${W} ${height}`}
      preserveAspectRatio="none"
      height={height}
      aria-hidden="true"
      focusable="false"
    >
      <path className="spark__area" d={area} />
      <path className="spark__line" d={line} />
    </svg>
  );
}

/* ── line chart ──────────────────────────────────────────────────────────── */

export interface LinePoint {
  day: string;
  value: number;
}

function shortDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
  });
}

/** Rupees, abbreviated the Indian way, for an axis where space is scarce. */
function compactINR(paise: number): string {
  const r = paise / 100;
  if (r >= 10_000_000) return `₹${(r / 10_000_000).toFixed(r % 10_000_000 === 0 ? 0 : 1)}Cr`;
  if (r >= 100_000) return `₹${(r / 100_000).toFixed(r % 100_000 === 0 ? 0 : 1)}L`;
  if (r >= 1_000) return `₹${(r / 1_000).toFixed(r % 1_000 === 0 ? 0 : 1)}K`;
  return `₹${Math.round(r)}`;
}

export function RecoveryLineChart({ data }: { data: LinePoint[] }) {
  const [hover, setHover] = useState<number | null>(null);

  const H = 210;
  const PAD_L = 52;
  const PAD_B = 26;
  const PAD_T = 10;
  const W = 620;

  const max = Math.max(1, ...data.map((d) => d.value));
  // Four gridlines including zero, at round-ish fractions of the peak.
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f));

  const plotW = W - PAD_L - 8;
  const plotH = H - PAD_B - PAD_T;
  const step = data.length > 1 ? plotW / (data.length - 1) : plotW;

  const x = (i: number) => PAD_L + i * step;
  const y = (v: number) => PAD_T + plotH - (v / max) * plotH;

  const line = data.map((d, i) => `${x(i)},${y(d.value)}`).join(" L");
  const area = `M${line} L${x(data.length - 1)},${PAD_T + plotH} L${PAD_L},${PAD_T + plotH} Z`;

  const active = hover !== null ? data[hover] : null;

  return (
    <div className="linechart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Revenue recovered over time">
        {ticks.map((t) => (
          <g key={t}>
            <line
              className="linechart__grid"
              x1={PAD_L}
              y1={y(t)}
              x2={W - 8}
              y2={y(t)}
            />
            <text className="linechart__ytick" x={PAD_L - 8} y={y(t) + 3.5} textAnchor="end">
              {t === 0 ? "0" : compactINR(t)}
            </text>
          </g>
        ))}

        {data.length > 0 && (
          <>
            <path className="linechart__area" d={area} />
            <path className="linechart__line" d={`M${line}`} />
            {data.map((d, i) => (
              <circle
                key={d.day}
                className={`linechart__dot${hover === i ? " is-hover" : ""}`}
                cx={x(i)}
                cy={y(d.value)}
                r={hover === i ? 5 : 3.5}
              />
            ))}
          </>
        )}

        {/* Full-height hit targets: the dots are too small to aim at, and a
            quiet day still has a value worth reading. */}
        {data.map((d, i) => (
          <rect
            key={`hit-${d.day}`}
            x={x(i) - step / 2}
            y={0}
            width={step}
            height={H}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          />
        ))}

        {data.map((d, i) => {
          // Label the ends and a few between, never every point.
          const stride = Math.max(1, Math.ceil(data.length / 7));
          if (i !== 0 && i !== data.length - 1 && i % stride !== 0) return null;
          return (
            <text
              key={`x-${d.day}`}
              className="linechart__xtick"
              x={x(i)}
              y={H - 8}
              textAnchor={i === 0 ? "start" : i === data.length - 1 ? "end" : "middle"}
            >
              {shortDay(d.day)}
            </text>
          );
        })}
      </svg>

      {active && (
        <div
          className="linechart__tip"
          style={{
            left: `${((x(hover!) - PAD_L) / plotW) * 100}%`,
            transform: `translateX(${
              hover! < data.length / 4
                ? "0"
                : hover! > (data.length * 3) / 4
                  ? "-100%"
                  : "-50%"
            })`,
          }}
        >
          <div className="linechart__tip-day">{shortDay(active.day)}</div>
          <div className="linechart__tip-val">{formatINR(active.value)}</div>
        </div>
      )}
    </div>
  );
}

/* ── donut ───────────────────────────────────────────────────────────────── */

export interface DonutSlice {
  key: string;
  label: string;
  value: number;
  count: number;
}

/**
 * Recovery split by failure cause.
 *
 * A donut is defensible here because the parts are mutually exclusive and sum
 * to something meaningful. The centre carries the total so nobody has to
 * estimate an angle, and every slice is labelled in the legend beside it.
 */
export function CauseDonut({
  slices,
  total,
  caption,
}: {
  slices: DonutSlice[];
  total: string;
  caption: string;
}) {
  const [hover, setHover] = useState<string | null>(null);

  const sum = slices.reduce((a, s) => a + s.value, 0);
  const R = 52;
  const C = 2 * Math.PI * R;

  let offset = 0;
  const arcs = slices.map((s, i) => {
    const frac = sum > 0 ? s.value / sum : 0;
    // A 2px gap between segments, converted to arc length.
    const gap = frac > 0 && slices.length > 1 ? 2 : 0;
    const arc = { ...s, index: i, len: Math.max(frac * C - gap, 0), offset, frac };
    offset += frac * C;
    return arc;
  });

  return (
    <div className="donut">
      <div className="donut__figure">
        <svg viewBox="0 0 136 136" role="img" aria-label={caption}>
          <circle cx="68" cy="68" r={R} className="donut__track" />
          {sum > 0 &&
            arcs.map((a) => (
              <circle
                key={a.key}
                cx="68"
                cy="68"
                r={R}
                fill="none"
                className={`donut__arc donut__arc--${a.index % 6}`}
                strokeWidth={hover === a.key ? 19 : 15}
                strokeDasharray={`${a.len} ${C - a.len}`}
                strokeDashoffset={-a.offset}
                transform="rotate(-90 68 68)"
                onMouseEnter={() => setHover(a.key)}
                onMouseLeave={() => setHover(null)}
              />
            ))}
        </svg>
        <div className="donut__centre">
          <div className="donut__total">{total}</div>
          <div className="donut__caption">{caption}</div>
        </div>
      </div>

      <ul className="donut__legend">
        {arcs.map((a) => (
          <li
            key={a.key}
            className={hover === a.key ? "is-hover" : undefined}
            onMouseEnter={() => setHover(a.key)}
            onMouseLeave={() => setHover(null)}
          >
            <i className={`donut__swatch donut__swatch--${a.index % 6}`} aria-hidden="true" />
            <span className="donut__label">{a.label}</span>
            <b>{formatINR(a.value)}</b>
            <span className="donut__pct">
              ({sum === 0 ? 0 : Math.round(a.frac * 100)}%)
            </span>
          </li>
        ))}
        {slices.length === 0 && <li className="donut__empty">Nothing in this window.</li>}
      </ul>
    </div>
  );
}
