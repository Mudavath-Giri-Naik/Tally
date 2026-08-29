"use client";

/**
 * The dashboard's charts.
 *
 * Hand-drawn SVG rather than a charting library: the whole app ships without a
 * chart dependency, these are the only two forms it needs, and a library would
 * be larger than the code below. They are client components purely so the
 * hover layer works - the data arrives already computed from the server.
 *
 * Colour: the three series are *states* (recovered / in flight / written
 * off), so they read as status colours, and each one is labelled as well as
 * coloured - never colour alone. The steps themselves live with the rest of
 * the theme in globals.css as `--s-*`, which is also what gives them a
 * separate dark set rather than a lightened flip of the light one.
 */
import { useState } from "react";
import { formatINR } from "@/lib/types";

export const SERIES = {
  recovered: { label: "Recovered" },
  at_risk: { label: "Still in flight" },
  lost: { label: "Written off" },
} as const;

export type SeriesKey = keyof typeof SERIES;

function shortDay(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

/* ── stacked daily bars ──────────────────────────────────────────────────── */

export interface DailyBar {
  day: string;
  recovered: number;
  at_risk: number;
}

/**
 * Money recovered against money still outstanding, per day.
 *
 * Stacked rather than grouped because the two parts sum to something
 * meaningful - the day's total exposure - and a merchant reads the height as
 * "how big was yesterday" before reading the split.
 */
export function DailyRecoveryChart({
  data,
  height = 200,
}: {
  data: DailyBar[];
  height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);

  const max = Math.max(1, ...data.map((d) => d.recovered + d.at_risk));
  const plotH = height - 26; // leave room for the day labels
  const barW = 100 / Math.max(data.length, 1);

  const active = hover !== null ? data[hover] : null;

  return (
    <div className="chart">
      <div className="chart__legend">
        {(["recovered", "at_risk"] as const).map((k) => (
          <span key={k} className="chart__legend-item">
            <i className="chart__swatch" style={{ background: `var(--s-${k})` }} />
            {SERIES[k].label}
          </span>
        ))}
      </div>

      <div className="chart__plot" style={{ height }}>
        {/* Three recessive gridlines. More would compete with the data. */}
        {[0.25, 0.5, 0.75].map((f) => (
          <span
            key={f}
            className="chart__grid"
            style={{ bottom: `${26 + f * plotH}px` }}
          />
        ))}

        <svg
          viewBox={`0 0 100 ${height}`}
          preserveAspectRatio="none"
          className="chart__svg"
          role="img"
          aria-label={`Recovery by day for the last ${data.length} days`}
        >
          {data.map((d, i) => {
            const total = d.recovered + d.at_risk;
            const x = i * barW;
            // A 2px surface gap between neighbouring bars, expressed in the
            // viewBox's horizontal units so it survives the non-uniform scale.
            const inset = barW * 0.18;
            const w = barW - inset * 2;
            const recH = (d.recovered / max) * plotH;
            const riskH = (d.at_risk / max) * plotH;
            const baseY = height - 26;

            return (
              <g
                key={d.day}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                className={hover === i ? "is-hover" : undefined}
              >
                {/* A full-height hit target: the bar itself is too small to
                    aim at on a quiet day, and an empty day still has a
                    tooltip worth reading. */}
                <rect
                  x={x}
                  y={0}
                  width={barW}
                  height={height}
                  fill="transparent"
                />
                {total === 0 ? (
                  <rect
                    x={x + inset}
                    y={baseY - 2}
                    width={w}
                    height={2}
                    className="chart__zero"
                  />
                ) : (
                  <>
                    <rect
                      x={x + inset}
                      y={baseY - riskH}
                      width={w}
                      height={riskH}
                      fill="var(--s-at_risk)"
                    />
                    <rect
                      x={x + inset}
                      y={baseY - riskH - recH}
                      width={w}
                      height={Math.max(recH - (riskH > 0 ? 1 : 0), 0)}
                      fill="var(--s-recovered)"
                    />
                  </>
                )}
              </g>
            );
          })}
        </svg>

        <div className="chart__axis">
          {data.map((d, i) => (
            // Only the ends and the middle are labelled; a label under every
            // bar collides at this width and adds nothing.
            <span key={d.day} className="chart__tick">
              {i === 0 || i === data.length - 1 || i === Math.floor(data.length / 2)
                ? shortDay(d.day)
                : ""}
            </span>
          ))}
        </div>

        {active && (
          <div
            className="chart__tip"
            style={{
              left: `${(hover! + 0.5) * barW}%`,
              // Flip the tooltip inward at the edges so it never runs off.
              transform: `translateX(${
                hover! < data.length / 4
                  ? "0"
                  : hover! > (data.length * 3) / 4
                    ? "-100%"
                    : "-50%"
              })`,
            }}
          >
            <div className="chart__tip-head">{shortDay(active.day)}</div>
            <div className="chart__tip-row">
              <i className="chart__swatch" style={{ background: "var(--s-recovered)" }} />
              Recovered
              <b>{formatINR(active.recovered)}</b>
            </div>
            <div className="chart__tip-row">
              <i className="chart__swatch" style={{ background: "var(--s-at_risk)" }} />
              In flight
              <b>{formatINR(active.at_risk)}</b>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── inline magnitude bar ────────────────────────────────────────────────── */

/**
 * The bar that sits inside a table row. One series, so one hue - the number
 * beside it carries the value and the bar carries the comparison.
 */
export function InlineBar({
  value,
  max,
  tone = "recovered",
}: {
  value: number;
  max: number;
  tone?: SeriesKey;
}) {
  const pct = max > 0 ? Math.max((value / max) * 100, value > 0 ? 3 : 0) : 0;
  return (
    <div className="inline-bar" aria-hidden="true">
      <span
        className="inline-bar__fill"
        style={{ width: `${pct}%`, background: `var(--s-${tone})` }}
      />
    </div>
  );
}

/* ── donut ───────────────────────────────────────────────────────────────── */

export interface DonutSlice {
  key: SeriesKey;
  label: string;
  value: number;
}

/**
 * Where the money stands right now. A donut is only defensible because there
 * are three mutually exclusive parts of one whole and the whole is the point;
 * the centre carries the total so the reader never has to estimate an angle.
 */
export function StatusDonut({
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
  const R = 54;
  const C = 2 * Math.PI * R;

  let offset = 0;
  const arcs = slices.map((s) => {
    const frac = sum > 0 ? s.value / sum : 0;
    // A 2px surface gap between segments, converted to arc length.
    const gap = frac > 0 && slices.length > 1 ? 2 : 0;
    const arc = { ...s, len: Math.max(frac * C - gap, 0), offset };
    offset += frac * C;
    return arc;
  });

  return (
    <div className="donut">
      <div className="donut__figure">
        <svg viewBox="0 0 140 140" role="img" aria-label={caption}>
          <circle cx="70" cy="70" r={R} className="donut__track" />
          {sum > 0 &&
            arcs.map((a) => (
              <circle
                key={a.key}
                cx="70"
                cy="70"
                r={R}
                fill="none"
                stroke={`var(--s-${a.key})`}
                strokeWidth={hover === a.key ? 20 : 16}
                strokeDasharray={`${a.len} ${C - a.len}`}
                strokeDashoffset={-a.offset}
                transform="rotate(-90 70 70)"
                onMouseEnter={() => setHover(a.key)}
                onMouseLeave={() => setHover(null)}
                style={{ transition: "stroke-width 120ms" }}
              />
            ))}
        </svg>
        <div className="donut__centre">
          <div className="donut__total">{total}</div>
          <div className="donut__caption">{caption}</div>
        </div>
      </div>

      <ul className="donut__legend">
        {slices.map((s) => (
          <li
            key={s.key}
            className={hover === s.key ? "is-hover" : undefined}
            onMouseEnter={() => setHover(s.key)}
            onMouseLeave={() => setHover(null)}
          >
            <i className="chart__swatch" style={{ background: `var(--s-${s.key})` }} />
            <span className="donut__legend-label">{s.label}</span>
            <b>{formatINR(s.value)}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}
