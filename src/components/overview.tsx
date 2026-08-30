"use client";

/**
 * The Overview: the whole merchant dashboard on one page.
 *
 * Server-rendered once with real figures, then kept current by the SSE stream
 * in /api/dashboard/[slug]/stream. Filtering, searching and paging are local
 * to the browser: the rows are already here, so narrowing them is a render
 * rather than a request.
 */
import { useEffect, useMemo, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { formatINR } from "@/lib/types";
import {
  BOARD_STATUSES,
  STATUS_META,
  RANGES,
  formatDuration,
  delta,
  type Dashboard,
  type BoardRow,
  type BoardStatus,
  type TimelineEntry,
} from "@/lib/board";
import { Sparkline, RecoveryLineChart, CauseDonut } from "@/components/charts";

const PAGE_SIZE = 8;

function initials(name: string | null): string {
  if (!name?.trim()) return "?";
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric", month: "short", year: "numeric",
  });
}

function shortTime(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

/* ── small pieces ────────────────────────────────────────────────────────── */

function ChannelMark({ channel }: { channel: string | null }) {
  if (!channel) return <span className="chan chan--none" title="Nothing has reached them yet">—</span>;

  const label = channel === "whatsapp" ? "WhatsApp" : channel === "voice" ? "Call" : "Email";
  return (
    <span className={`chan chan--${channel}`} title={`Last reached by ${label}`}>
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
        {channel === "email" && (
          <>
            <rect x="1.2" y="3.2" width="13.6" height="9.6" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M1.8 4.4 8 8.9l6.2-4.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </>
        )}
        {channel === "whatsapp" && (
          <path d="M8 1.6a6.4 6.4 0 0 0-5.5 9.65L1.7 14.4l3.25-.8A6.4 6.4 0 1 0 8 1.6Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        )}
        {channel === "voice" && (
          <path d="M4.1 2.2c.7 0 1 .4 1.3 1l.6 1.5c.2.5.1.8-.3 1.15l-.7.6a7.4 7.4 0 0 0 3.6 3.6l.6-.7c.35-.4.65-.5 1.15-.3l1.5.6c.6.25 1 .6 1 1.3 0 1.4-1.2 2.4-2.5 2.2C6.4 12.6 3.4 9.6 2 5.2 1.7 3.7 2.7 2.2 4.1 2.2Z" fill="currentColor" />
        )}
      </svg>
      <span className="chan__label">{label}</span>
    </span>
  );
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

function Delta({ value, riseIsGood = true }: { value: number | null; riseIsGood?: boolean }) {
  // No previous period is not a change of zero - saying "0%" would claim a
  // comparison that was never made.
  if (value === null) return <span className="delta delta--none">no prior period</span>;
  if (value === 0) return <span className="delta">no change</span>;
  const good = value > 0 === riseIsGood;
  return (
    <span className={`delta ${good ? "delta--up" : "delta--down"}`}>
      {value > 0 ? "▲" : "▼"} {Math.abs(value)}%
    </span>
  );
}

function MetricCard({
  tone, label, value, sub, deltaValue, riseIsGood = true, spark, icon,
}: {
  tone: string;
  label: string;
  value: string;
  sub?: string;
  deltaValue: number | null;
  riseIsGood?: boolean;
  spark: number[];
  icon: React.ReactNode;
}) {
  return (
    <div className={`mcard mcard--${tone}`}>
      <div className="mcard__top">
        <span className="mcard__label">{label}</span>
        <span className="mcard__icon" aria-hidden="true">{icon}</span>
      </div>
      <div className="mcard__value">{value}</div>
      <div className="mcard__foot">
        <Delta value={deltaValue} riseIsGood={riseIsGood} />
        {sub && <span className="mcard__sub">{sub}</span>}
      </div>
      <Sparkline values={spark} tone={tone} />
    </div>
  );
}

/* ── the page ────────────────────────────────────────────────────────────── */

export function Overview({ slug, initial }: { slug: string; initial: Dashboard }) {
  const router = useRouter();
  const [data, setData] = useState<Dashboard>(initial);
  const [tab, setTab] = useState<BoardStatus | "all">("all");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [channelFilter, setChannelFilter] = useState("");
  const [page, setPage] = useState(1);
  const [openEvent, setOpenEvent] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[] | null>(null);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [live, setLive] = useState(false);

  // Server-rendered data changes when the range does; adopt it.
  useEffect(() => setData(initial), [initial]);

  useEffect(() => {
    const source = new EventSource(`/api/dashboard/${slug}/stream?days=${initial.days}`);
    source.addEventListener("board", (e) => {
      try {
        setData(JSON.parse((e as MessageEvent).data) as Dashboard);
        setLive(true);
      } catch {
        // A truncated frame; the next push carries the same state.
      }
    });
    // Dropping is normal: the server closes the stream just short of the
    // platform's function limit and EventSource reconnects by itself.
    source.onerror = () => setLive(false);
    return () => source.close();
  }, [slug, initial.days]);

  const m = data.metrics;
  const p = data.previous;

  /* ── filtering ── */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.rows.filter((r) => {
      if (statusFilter && r.status !== statusFilter) return false;
      if (channelFilter && (r.last_channel ?? "none") !== channelFilter) return false;
      if (tab !== "all" && r.status !== tab) return false;
      if (!q) return true;
      const amount = r.amount === null ? "" : String(Math.round(r.amount / 100));
      return (
        (r.customer_name ?? "").toLowerCase().includes(q) ||
        r.reason_label.toLowerCase().includes(q) ||
        r.reason.toLowerCase().includes(q) ||
        amount.includes(q)
      );
    });
  }, [data.rows, query, statusFilter, channelFilter, tab]);

  // Counts describe the search results, not the whole table - a count that
  // ignored the active search would send someone to an empty tab.
  const counts = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = data.rows.filter((r) => {
      if (statusFilter && r.status !== statusFilter) return false;
      if (channelFilter && (r.last_channel ?? "none") !== channelFilter) return false;
      if (!q) return true;
      const amount = r.amount === null ? "" : String(Math.round(r.amount / 100));
      return (
        (r.customer_name ?? "").toLowerCase().includes(q) ||
        r.reason_label.toLowerCase().includes(q) ||
        r.reason.toLowerCase().includes(q) ||
        amount.includes(q)
      );
    });
    const out: Record<string, number> = { all: base.length };
    for (const s of BOARD_STATUSES) out[s] = 0;
    for (const r of base) out[r.status] = (out[r.status] ?? 0) + 1;
    return out;
  }, [data.rows, query, statusFilter, channelFilter]);

  // Any narrowing invalidates the page number: page 3 of the old result set is
  // not page 3 of the new one.
  useEffect(() => setPage(1), [query, statusFilter, channelFilter, tab]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pages);
  const visible = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const from = filtered.length === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1;
  const to = Math.min(safePage * PAGE_SIZE, filtered.length);

  /* ── detail panel ── */
  const openRow = useMemo(
    () => data.rows.find((r) => r.event_id === openEvent) ?? null,
    [data.rows, openEvent],
  );

  const toggleRow = useCallback(
    async (eventId: string) => {
      if (openEvent === eventId) { setOpenEvent(null); return; }
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

  /* ── export ── */
  const exportCsv = useCallback(() => {
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const compliance = m.sent_total === 0 ? "" : Math.round((m.sent_in_window / m.sent_total) * 100);
    const lines: string[] = [
      `Tally export,${new Date().toISOString()}`,
      `Range,Last ${data.days} days,${data.from},${data.to}`,
      "",
      "Summary,Value",
      `Revenue recovered,${m.amount_recovered / 100}`,
      `Recoveries,${m.recovered_count}`,
      `Recovery rate %,${m.recovery_rate}`,
      `Revenue at risk,${m.amount_at_risk / 100}`,
      `Interventions sent,${m.sent_total}`,
      `Compliance %,${compliance}`,
      `Needs a human,${m.needs_human}`,
      `Promise-to-pay active,${m.promise_active}`,
      `Escalated to voice,${m.escalated_voice}`,
      `Stopped,${m.stopped}`,
      "",
      "Customer,Amount,Reason,Channel,Status,Attempts,Failed on",
      ...filtered.map((r) =>
        [
          esc(r.customer_name ?? "Unknown"),
          r.amount === null ? "" : r.amount / 100,
          esc(r.reason_label),
          esc(r.last_channel ?? ""),
          esc(STATUS_META[r.status].label),
          `${r.attempts}/${r.max_attempts}`,
          r.failed_on.slice(0, 10),
        ].join(","),
      ),
    ];

    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tally-${slug}-${data.days}d-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filtered, m, data.days, data.from, data.to, slug]);

  /* ── derived figures ── */
  const compliance = m.sent_total === 0 ? null : Math.round((m.sent_in_window / m.sent_total) * 100);
  const prevCompliance = p.sent_total === 0 ? null : Math.round((p.sent_in_window / p.sent_total) * 100);

  const spark = {
    recovered: data.series.map((d) => d.amount_recovered),
    rate: data.series.map((d) => (d.events === 0 ? 0 : (d.recovered / d.events) * 100)),
    risk: data.series.map((d) => d.amount_at_risk),
    sent: data.series.map((d) => d.sent),
    compliance: data.series.map((d) => (d.sent === 0 ? 0 : (d.sent_in_window / d.sent) * 100)),
  };

  const donutSlices = m.top_causes.map((c) => ({
    key: c.reason,
    label: c.label,
    value: data.rows
      .filter((r) => r.reason === c.reason)
      .reduce((sum, r) => sum + (r.amount ?? 0), 0),
    count: c.count,
  }));

  return (
    <>
      {/* ── top bar ── */}
      <header className="topline">
        <div>
          <h1>Overview</h1>
          <p className="topline__sub">
            Every recovery for this business, in one place · last {data.days} days
          </p>
        </div>
        <div className="topline__tools">
          <span className={`livedot${live ? " is-live" : ""}`}>
            {live ? "Live" : "Reconnecting"}
          </span>
          <label className="rangepick">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <rect x="2" y="3.2" width="12" height="11" rx="1.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <path d="M2 6.6h12M5.4 1.8v2.6M10.6 1.8v2.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
            <select
              value={data.days}
              aria-label="Date range"
              onChange={(e) => router.push(`?range=${e.target.value}`, { scroll: false })}
            >
              {RANGES.map((d) => (
                <option key={d} value={d}>Last {d} days</option>
              ))}
            </select>
          </label>
          <button type="button" className="btn btn--primary" onClick={exportCsv}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M8 2v8m0 0 3-3m-3 3L5 7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M2.8 11.4v1.4a1 1 0 0 0 1 1h8.4a1 1 0 0 0 1-1v-1.4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            Export report
          </button>
        </div>
      </header>

      {/* ── metric row ── */}
      <div className="mrow">
        <MetricCard
          tone="green" label="Revenue recovered"
          value={formatINR(m.amount_recovered)}
          sub={`${m.recovered_count} recovered`}
          deltaValue={delta(m.amount_recovered, p.amount_recovered)}
          spark={spark.recovered}
          icon="₹"
        />
        <MetricCard
          tone="purple" label="Recovery rate"
          value={`${m.recovery_rate}%`}
          sub={`of ${m.total_events} events`}
          deltaValue={delta(m.recovery_rate, p.recovery_rate)}
          spark={spark.rate}
          icon="◎"
        />
        <MetricCard
          tone="amber" label="Revenue at risk"
          value={formatINR(m.amount_at_risk)}
          sub="still open"
          deltaValue={delta(m.amount_at_risk, p.amount_at_risk)}
          riseIsGood={false}
          spark={spark.risk}
          icon="⚠"
        />
        <MetricCard
          tone="blue" label="Interventions sent"
          value={String(m.sent_total)}
          sub="messages delivered"
          deltaValue={delta(m.sent_total, p.sent_total)}
          spark={spark.sent}
          icon="➤"
        />
        <MetricCard
          tone="teal" label="Compliance"
          value={compliance === null ? "—" : `${compliance}%`}
          sub={m.sent_total === 0 ? "nothing sent" : `${m.sent_in_window}/${m.sent_total} in-window`}
          deltaValue={compliance === null || prevCompliance === null ? null : delta(compliance, prevCompliance)}
          spark={spark.compliance}
          icon="✓"
        />
      </div>

      <p className="causes">
        {m.top_causes.length === 0 ? (
          <span className="causes__empty">No open failures in this window.</span>
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
      </p>

      {/* ── charts ── */}
      <div className="chartrow">
        <section className="panel panel--wide">
          <div className="panel__head">
            <h2>Revenue recovered over time</h2>
            <span className="panel__note">daily</span>
          </div>
          <div className="panel__body">
            <RecoveryLineChart
              data={data.series.map((d) => ({ day: d.day, value: d.amount_recovered }))}
            />
          </div>
        </section>

        <section className="panel">
          <div className="panel__head"><h2>Recovery by cause</h2></div>
          <div className="panel__body">
            <CauseDonut
              slices={donutSlices}
              total={formatINR(m.amount_recovered)}
              caption="recovered"
            />
          </div>
        </section>

        <section className="panel">
          <div className="panel__head">
            <h2>Recovery rate by channel</h2>
            <span className="panel__note">of events reached</span>
          </div>
          <div className="panel__body">
            <ul className="chanrank">
              {[...data.channels]
                .sort((a, b) => b.rate - a.rate || b.reached - a.reached)
                .map((c) => (
                  <li key={c.channel}>
                    <ChannelMark channel={c.channel} />
                    <div className="chanrank__bar">
                      <span
                        className={`chanrank__fill chanrank__fill--${c.channel}`}
                        style={{ width: `${Math.max(c.rate, c.rate > 0 ? 4 : 0)}%` }}
                      />
                    </div>
                    <span className="chanrank__rate">{c.rate}%</span>
                    <span className="chanrank__sent">{c.sent} sent</span>
                  </li>
                ))}
            </ul>
          </div>
        </section>
      </div>

      {/* ── status cards ── */}
      <div className="srow">
        <div className="scard scard--human">
          <div className="scard__label">Needs a human</div>
          <div className="scard__value">{m.needs_human}</div>
          <div className="scard__sub">risk flags and repeat failures</div>
        </div>
        <div className="scard scard--promise">
          <div className="scard__label">Promise-to-pay active</div>
          <div className="scard__value">{m.promise_active}</div>
          <div className="scard__sub">awaiting a promised date</div>
        </div>
        <div className="scard scard--voice">
          <div className="scard__label">Escalated to voice</div>
          <div className="scard__value">{m.escalated_voice}</div>
          <div className="scard__sub">a call was placed</div>
        </div>
        <div className="scard scard--stopped">
          <div className="scard__label">Stopped</div>
          <div className="scard__value">{m.stopped}</div>
          <div className="scard__sub">capped or opted out</div>
        </div>
      </div>

      {/* ── table ── */}
      <section className="panel panel--table">
        <div className="panel__head">
          <h2>Recoveries</h2>
          <div className="tablefilters">
            <div className="searchbox">
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
                <path d="m10.6 10.6 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <input
                type="text" value={query} placeholder="Search customer, cause or amount"
                aria-label="Search recoveries"
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <select value={statusFilter} aria-label="Filter by status"
                    onChange={(e) => { setStatusFilter(e.target.value); setTab("all"); }}>
              <option value="">All status</option>
              {BOARD_STATUSES.map((s) => (
                <option key={s} value={s}>{STATUS_META[s].label}</option>
              ))}
            </select>
            <select value={channelFilter} aria-label="Filter by channel"
                    onChange={(e) => setChannelFilter(e.target.value)}>
              <option value="">All channels</option>
              <option value="email">Email</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="voice">Voice</option>
              <option value="none">Not reached</option>
            </select>
          </div>
        </div>

        <div className="tabs" role="tablist" aria-label="Filter by status">
          <button type="button" role="tab" aria-selected={tab === "all"}
                  className={`tab${tab === "all" ? " is-active" : ""}`}
                  onClick={() => { setTab("all"); setStatusFilter(""); }}>
            All customers<span className="tab__count">{counts.all}</span>
          </button>
          {BOARD_STATUSES.map((s) => (
            <button key={s} type="button" role="tab" aria-selected={tab === s}
                    className={`tab${tab === s ? " is-active" : ""}`}
                    onClick={() => { setTab(s); setStatusFilter(""); }}>
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
            {data.rows.length === 0
              ? "No events in this window. The first failed payment on your Razorpay account appears here within a minute."
              : "Nothing matches these filters."}
          </div>
        ) : (
          <>
            <div className="table-wrap table-wrap--flush">
              <table className="board">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th className="num">Amount</th>
                    <th>Reason</th>
                    <th>Channel</th>
                    <th>Status</th>
                    <th className="num">Attempts</th>
                    <th>Failed on</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row) => (
                    <Row key={row.event_id} row={row}
                         open={openEvent === row.event_id}
                         onToggle={() => void toggleRow(row.event_id)} />
                  ))}
                </tbody>
              </table>
            </div>

            <div className="pager">
              <span className="pager__count">
                Showing {from}–{to} of {filtered.length}
              </span>
              <div className="pager__buttons">
                <button type="button" className="pgbtn" disabled={safePage <= 1}
                        onClick={() => setPage(safePage - 1)} aria-label="Previous page">‹</button>
                {Array.from({ length: pages }, (_, i) => i + 1)
                  .filter((n) => n === 1 || n === pages || Math.abs(n - safePage) <= 1)
                  .map((n, i, arr) => (
                    <span key={n} style={{ display: "contents" }}>
                      {i > 0 && arr[i - 1] !== n - 1 && <span className="pager__gap">…</span>}
                      <button type="button"
                              className={`pgbtn${n === safePage ? " is-active" : ""}`}
                              onClick={() => setPage(n)}>{n}</button>
                    </span>
                  ))}
                <button type="button" className="pgbtn" disabled={safePage >= pages}
                        onClick={() => setPage(safePage + 1)} aria-label="Next page">›</button>
              </div>
            </div>
          </>
        )}
      </section>

      {openRow && (
        <DetailPanel row={openRow} entries={timeline} error={timelineError}
                     onClose={() => setOpenEvent(null)} />
      )}
    </>
  );
}

function Row({ row, open, onToggle }: { row: BoardRow; open: boolean; onToggle: () => void }) {
  return (
    <tr className={`board__row${open ? " is-open" : ""}`} onClick={onToggle}
        tabIndex={0} role="button" aria-expanded={open}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); }
        }}>
      <td>
        <div className="who">
          <span className={`avatar avatar--${STATUS_META[row.status].token}`} aria-hidden="true">
            {initials(row.customer_name)}
          </span>
          <span className="who__name">{row.customer_name ?? "Unknown"}</span>
        </div>
      </td>
      <td className="num money">{formatINR(row.amount)}</td>
      <td><span className="badge">{row.reason_label}</span></td>
      <td><ChannelMark channel={row.last_channel} /></td>
      <td><StatusPill status={row.status} /></td>
      <td className="num">
        <span className={`attempts${row.attempts >= row.max_attempts ? " is-spent" : ""}`}>
          {row.attempts}/{row.max_attempts}
        </span>
      </td>
      <td className="muted small nowrap">{shortDate(row.failed_on)}</td>
    </tr>
  );
}

function DetailPanel({
  row, entries, error, onClose,
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
            <ChannelMark channel={row.last_channel} />
          </div>
        </div>
        <button type="button" className="detail__close" onClick={onClose} aria-label="Close">✕</button>
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
                  {e.in_window === false && <span className="badge badge--flag">outside window</span>}
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
        {row.status === "recovered"
          ? <>Recovered in <strong>{formatDuration(elapsed)}</strong></>
          : <>Open for <strong>{formatDuration(elapsed)}</strong></>}
        {" · "}<strong>{row.attempts}</strong> of {row.max_attempts} attempts used{" · "}
        {sent.length === 0 ? "nothing sent yet"
          : outOfWindow === 0
            ? <span className="ok">all {sent.length} messages within the contact window</span>
            : <span className="flag">{outOfWindow} of {sent.length} sent outside the contact window</span>}
      </footer>
    </section>
  );
}
