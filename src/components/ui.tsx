/**
 * The dashboard's shared furniture.
 *
 * Server components, deliberately - none of these need state, and keeping
 * them off the client means a table of two hundred rows ships as markup
 * rather than as props plus a hydration pass.
 */
import type { ReactNode } from "react";

export function PageHead({
  title,
  lede,
  actions,
}: {
  title: string;
  lede?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="pagehead">
      <div>
        <h1>{title}</h1>
        {lede && <p className="pagehead__lede">{lede}</p>}
      </div>
      {actions && <div className="pagehead__actions">{actions}</div>}
    </header>
  );
}

/**
 * A headline number.
 *
 * `delta` is a percentage change against the previous period, or null when
 * there was no previous period to compare against - which is rendered as
 * "no prior period", never as 0% or +100%.
 */
export function StatCard({
  label,
  value,
  sub,
  delta,
  deltaSuffix = "%",
  /** Whether a rise is good news. Recovery: yes. Failures: no. */
  riseIsGood = true,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  delta?: number | null;
  deltaSuffix?: string;
  riseIsGood?: boolean;
  tone?: "good" | "warn" | "bad";
}) {
  const showDelta = delta !== undefined;
  const good = delta !== null && delta !== undefined && delta !== 0
    ? (delta > 0) === riseIsGood
    : null;

  return (
    <div className="statcard">
      <div className="statcard__label">{label}</div>
      <div className={`statcard__value${tone ? ` is-${tone}` : ""}`}>{value}</div>
      <div className="statcard__foot">
        {showDelta &&
          (delta === null ? (
            <span className="delta delta--none">no prior period</span>
          ) : (
            <span
              className={`delta${good === null ? "" : good ? " delta--up" : " delta--down"}`}
            >
              {delta > 0 ? "▲" : delta < 0 ? "▼" : "="}{" "}
              {Math.abs(delta)}
              {deltaSuffix}
            </span>
          ))}
        {sub && <span className="statcard__sub">{sub}</span>}
      </div>
    </div>
  );
}

const PILL_TONE: Record<string, string> = {
  // event statuses
  recovered: "good",
  queued: "info",
  processing: "accent",
  stopped: "warn",
  unrecoverable: "bad",
  // action outcomes
  sent: "good",
  delivered: "good",
  failed: "bad",
  escalated: "warn",
  skipped: "info",
  no_action: "info",
  pending: "info",
};

export function StatusPill({ value }: { value: string }) {
  return (
    <span className={`pill pill--${PILL_TONE[value] ?? "info"}`}>
      {value.replace(/_/g, " ")}
    </span>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="emptystate">
      <div className="emptystate__title">{title}</div>
      <p className="emptystate__body">{body}</p>
      {action}
    </div>
  );
}

export function Panel({
  title,
  hint,
  action,
  children,
  flush = false,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
  /** Drop the padding, for a panel whose whole body is a table. */
  flush?: boolean;
}) {
  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>{title}</h2>
          {hint && <p className="panel__hint">{hint}</p>}
        </div>
        {action}
      </div>
      <div className={`panel__body${flush ? " is-flush" : ""}`}>{children}</div>
    </section>
  );
}

/**
 * Relative time, for a column where the exact timestamp is noise.
 *
 * Handles both directions: a scheduled retry is in the future, and rendering
 * that as "0s ago" - which is what a past-only helper does - reads as though
 * it already happened.
 */
export function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  const secs = Math.abs(diff);
  const suffix = (unit: string) => (diff >= 0 ? `${unit} ago` : `in ${unit}`);

  if (secs < 60) return suffix(`${secs}s`);
  if (secs < 3600) return suffix(`${Math.floor(secs / 60)}m`);
  if (secs < 86400) return suffix(`${Math.floor(secs / 3600)}h`);
  if (secs < 2592000) return suffix(`${Math.floor(secs / 86400)}d`);
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
