"use client";

/**
 * The recovery board.
 *
 * Server-rendered once with real data, then kept current by the SSE stream in
 * /api/dashboard/[slug]/stream. Tab filtering is local to the browser - the
 * rows are already here, so narrowing them is a render, not a request.
 */
import { useEffect, useMemo, useState, useCallback } from "react";
import { formatINR } from "@/lib/types";
import {
  BOARD_STATUSES,
  STATUS_META,
  formatDuration,
  type Board,
  type BoardRow,
  type BoardStatus,
  type TimelineEntry,
} from "@/lib/board";

function initials(name: string | null): string {
  if (!name?.trim()) return "?";
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function shortTime(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function StatusPill({ status }: { status: BoardStatus }) {
  const meta = STATUS_META[status];
  return (
    <span className={`bpill bpill--${meta.token}`}>
      <span aria-hidden="true">{meta.icon}</span>
      {meta.label}
    </span>
  );
}

export function LiveBoard({
  slug,
  initial,
}: {
  slug: string;
  initial: Board;
}) {
  const [board, setBoard] = useState<Board>(initial);
  const [tab, setTab] = useState<BoardStatus | "all">("all");
  const [query, setQuery] = useState("");
  const [openEvent, setOpenEvent] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[] | null>(null);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [live, setLive] = useState(false);

  // ── the stream ─────────────────────────────────────────────────────────
  useEffect(() => {
    const source = new EventSource(`/api/dashboard/${slug}/stream`);

    source.addEventListener("board", (e) => {
      try {
        setBoard(JSON.parse((e as MessageEvent).data) as Board);
        setLive(true);
      } catch {
        // A truncated frame; the next push carries the same state.
      }
    });
    // The connection dropping is normal - the server closes it just short of
    // the platform's function limit and EventSource reconnects by itself.
    source.onerror = () => setLive(false);

    return () => source.close();
  }, [slug]);

  // Search first, then the tab. Doing it in this order is what makes the tab
  // counts describe the search results rather than the whole table - a count
  // that ignores the active search sends the merchant to an empty tab.
  const searched = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return board.rows;
    return board.rows.filter((r) => {
      const amount = r.amount === null ? "" : String(Math.round(r.amount / 100));
      return (
        (r.customer_name ?? "").toLowerCase().includes(q) ||
        r.reason_label.toLowerCase().includes(q) ||
        r.reason.toLowerCase().includes(q) ||
        amount.includes(q)
      );
    });
  }, [board.rows, query]);

  const counts = useMemo(() => {
    const out: Record<string, number> = { all: searched.length };
    for (const s of BOARD_STATUSES) out[s] = 0;
    for (const r of searched) out[r.status] = (out[r.status] ?? 0) + 1;
    return out;
  }, [searched]);

  const visible = useMemo(
    () => (tab === "all" ? searched : searched.filter((r) => r.status === tab)),
    [searched, tab],
  );

  // ── the detail panel ───────────────────────────────────────────────────
  const openRow = useMemo(
    () => board.rows.find((r) => r.event_id === openEvent) ?? null,
    [board.rows, openEvent],
  );

  const toggleRow = useCallback(
    async (eventId: string) => {
      if (openEvent === eventId) {
        setOpenEvent(null);
        return;
      }
      setOpenEvent(eventId);
      setTimeline(null);
      setTimelineError(null);
      try {
        const res = await fetch(`/api/dashboard/${slug}/timeline/${eventId}`);
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as { entries: TimelineEntry[] };
        setTimeline(json.entries);
      } catch {
        setTimelineError("That timeline could not be loaded. Try again.");
      }
    },
    [openEvent, slug],
  );

  const m = board.metrics;
  const compliance =
    m.sent_total === 0 ? null : Math.round((m.sent_in_window / m.sent_total) * 100);

  return (
    <>
      {/* ── layer 1: the numbers ── */}
      <div className="metrics">
        <div className="metric">
          <div className="metric__label">Recovered</div>
          <div className="metric__value">
            {m.recovered_count}
            <span className="metric__of">/{m.total_events}</span>
          </div>
          <div className="metric__sub">
            {formatINR(m.amount_recovered)} of {formatINR(m.amount_total)} ·{" "}
            <strong>{m.recovery_rate}%</strong>
          </div>
        </div>

        <div className="metric">
          <div className="metric__label">Avg recovery time</div>
          <div className="metric__value">
            {formatDuration(m.avg_recovery_seconds)}
          </div>
          <div className="metric__sub">
            {m.recovered_count > 0
              ? `across ${m.recovered_count} recovered`
              : "nothing recovered yet"}
          </div>
        </div>

        <div className="metric">
          <div className="metric__label">Compliance</div>
          <div
            className={`metric__value${compliance !== null && compliance < 100 ? " is-warn" : ""}`}
          >
            {compliance === null ? "—" : `${compliance}%`}
          </div>
          <div className="metric__sub">
            {m.sent_total === 0
              ? "nothing sent yet"
              : `${m.sent_in_window} of ${m.sent_total} in-window`}
          </div>
        </div>

        <div className="metric">
          <div className="metric__label">Needs a human</div>
          <div className={`metric__value${m.needs_human > 0 ? " is-human" : ""}`}>
            {m.needs_human}
          </div>
          <div className="metric__sub">
            {m.needs_human === 0 ? "nothing waiting" : "waiting on someone"}
          </div>
        </div>
      </div>

      <p className="causes">
        {m.top_causes.length === 0 ? (
          <span className="causes__empty">No open failures this period.</span>
        ) : (
          <>
            <span className="causes__label">Top causes:</span>{" "}
            {m.top_causes.map((c, i) => (
              <span key={c.reason}>
                {i > 0 && <span className="causes__sep"> · </span>}
                {c.label} ({c.count})
              </span>
            ))}
          </>
        )}
        <span className={`livedot${live ? " is-live" : ""}`} title={live ? "Live" : "Reconnecting"}>
          {live ? "Live" : "Reconnecting"}
        </span>
      </p>

      {/* ── layer 2: search, tabs, table ── */}
      <div className="boardbar">
        <input
          type="text"
          className="boardbar__search"
          value={query}
          placeholder="Search customer, cause or amount"
          aria-label="Search the board"
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button
            type="button"
            className="boardbar__clear"
            onClick={() => setQuery("")}
          >
            Clear
          </button>
        )}
        <span className="boardbar__count">
          {visible.length} of {board.rows.length}
        </span>
      </div>

      <div className="tabs" role="tablist" aria-label="Filter by status">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "all"}
          className={`tab${tab === "all" ? " is-active" : ""}`}
          onClick={() => setTab("all")}
        >
          All customers
          <span className="tab__count">{counts.all}</span>
        </button>
        {BOARD_STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={tab === s}
            className={`tab${tab === s ? " is-active" : ""}`}
            onClick={() => setTab(s)}
          >
            <span className={`dot dot--${STATUS_META[s].token}`} aria-hidden="true">
              {STATUS_META[s].icon}
            </span>
            {STATUS_META[s].label}
            <span className="tab__count">{counts[s] ?? 0}</span>
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="board-empty">
          {board.rows.length === 0
            ? "No events yet. The first failed payment on your Razorpay account appears here within a minute."
            : query
              ? `Nothing matches "${query}".`
              : "Nothing in this state right now."}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="board">
            <thead>
              <tr>
                <th>Customer</th>
                <th className="num">Amount</th>
                <th>Reason</th>
                <th>Status</th>
                <th className="num">Attempts</th>
                <th>Failed on</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <BoardRowView
                  key={row.event_id}
                  row={row}
                  open={openEvent === row.event_id}
                  onToggle={() => void toggleRow(row.event_id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── layer 3: the detail panel ── */}
      {openRow && (
        <DetailPanel
          row={openRow}
          entries={timeline}
          error={timelineError}
          onClose={() => setOpenEvent(null)}
        />
      )}
    </>
  );
}

function BoardRowView({
  row,
  open,
  onToggle,
}: {
  row: BoardRow;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <tr
      className={`board__row${open ? " is-open" : ""}`}
      onClick={onToggle}
      tabIndex={0}
      role="button"
      aria-expanded={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
        }
      }}
    >
      <td>
        <div className="who">
          <span className={`avatar avatar--${STATUS_META[row.status].token}`} aria-hidden="true">
            {initials(row.customer_name)}
          </span>
          <span className="who__name">{row.customer_name ?? "Unknown"}</span>
        </div>
      </td>
      <td className="num money">{formatINR(row.amount)}</td>
      <td>
        <span className="badge">{row.reason_label}</span>
      </td>
      <td>
        <StatusPill status={row.status} />
      </td>
      <td className="num">
        <span
          className={`attempts${row.attempts >= row.max_attempts ? " is-spent" : ""}`}
        >
          {row.attempts}/{row.max_attempts}
        </span>
      </td>
      <td className="muted small nowrap">{shortDate(row.failed_on)}</td>
    </tr>
  );
}

function DetailPanel({
  row,
  entries,
  error,
  onClose,
}: {
  row: BoardRow;
  entries: TimelineEntry[] | null;
  error: string | null;
  onClose: () => void;
}) {
  const sent = entries?.filter((e) => e.in_window !== null) ?? [];
  const outOfWindow = sent.filter((e) => e.in_window === false).length;

  const elapsed =
    row.recovered_at !== null
      ? (Date.parse(row.recovered_at) - Date.parse(row.failed_on)) / 1000
      : (Date.now() - Date.parse(row.failed_on)) / 1000;

  return (
    <section className="detail" aria-label={`Timeline for ${row.customer_name ?? "this customer"}`}>
      <header className="detail__head">
        <span className={`avatar avatar--lg avatar--${STATUS_META[row.status].token}`} aria-hidden="true">
          {initials(row.customer_name)}
        </span>
        <div className="detail__who">
          <div className="detail__name">{row.customer_name ?? "Unknown customer"}</div>
          <div className="detail__meta">
            <strong>{formatINR(row.amount)}</strong>
            <span className="badge">{row.reason_label}</span>
            <StatusPill status={row.status} />
          </div>
        </div>
        <button type="button" className="detail__close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>

      {error && <div className="detail__error">{error}</div>}

      {!entries && !error && <div className="detail__loading">Loading the timeline…</div>}

      {entries && entries.length === 0 && (
        <div className="detail__loading">Nothing has happened on this event yet.</div>
      )}

      {entries && entries.length > 0 && (
        <ol className="tl">
          {entries.map((e) => (
            <li key={e.id} className={`tl__item tl__item--${e.outcome}`}>
              <div className="tl__time">{shortTime(e.created_at)}</div>
              <div className="tl__body">
                <div className="tl__head">
                  <span className={`tl__outcome tl__outcome--${e.outcome}`}>
                    {e.outcome.replace(/_/g, " ")}
                  </span>
                  {e.channel && <span className="badge badge--quiet">{e.channel}</span>}
                  {e.in_window === false && (
                    <span className="badge badge--flag">outside window</span>
                  )}
                  {e.guardrail && (
                    <span className="badge badge--quiet">{e.guardrail.replace(/_/g, " ")}</span>
                  )}
                </div>
                {e.rationale && <div className="tl__why">{e.rationale}</div>}
                {e.message && <div className="tl__msg">{e.message}</div>}
              </div>
            </li>
          ))}
        </ol>
      )}

      <footer className="detail__foot">
        {row.status === "recovered" ? (
          <>Recovered in <strong>{formatDuration(elapsed)}</strong></>
        ) : (
          <>Open for <strong>{formatDuration(elapsed)}</strong></>
        )}
        {" · "}
        <strong>{row.attempts}</strong> of {row.max_attempts} attempts used
        {" · "}
        {sent.length === 0 ? (
          "nothing sent yet"
        ) : outOfWindow === 0 ? (
          <span className="ok">all {sent.length} messages within the contact window</span>
        ) : (
          <span className="flag">
            {outOfWindow} of {sent.length} sent outside the contact window
          </span>
        )}
      </footer>
    </section>
  );
}
