/**
 * The merchant dashboard.
 *
 * Money recovered, what the agent did, and why. Rendered on the server so no
 * credential or service key ever reaches the browser.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { getMerchant, toPublic } from "@/lib/merchants";
import {
  merchantStats,
  failureReasons,
  channelPerformance,
  auditTrail,
} from "@/lib/insights";
import { listEvents } from "@/lib/events";
import { formatINR } from "@/lib/types";
import { PUBLIC_URL } from "@/lib/env";

export const dynamic = "force-dynamic";

function timeAgo(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

const OUTCOME_PILL: Record<string, string> = {
  sent: "pill--good",
  delivered: "pill--good",
  failed: "pill--bad",
  escalated: "pill--warn",
  skipped: "pill--info",
  no_action: "pill--info",
  pending: "pill--info",
};

const STATUS_PILL: Record<string, string> = {
  recovered: "pill--good",
  queued: "pill--info",
  processing: "pill--accent",
  stopped: "pill--warn",
  unrecoverable: "pill--bad",
};

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ merchantId: string }>;
}) {
  const { merchantId } = await params;

  const merchant = await getMerchant(merchantId).catch(() => null);
  if (!merchant) notFound();

  const [stats, reasons, channels, audit, events] = await Promise.all([
    merchantStats(merchantId),
    failureReasons(merchantId, 7),
    channelPerformance(merchantId),
    auditTrail(merchantId, 40),
    listEvents(merchantId, 25),
  ]);

  const pub = toPublic(merchant, PUBLIC_URL());

  return (
    <div className="shell" style={{ paddingTop: 40 }}>
      <div className="section__head">
        <h1>{merchant.business_name}</h1>
        <span className={`pill ${merchant.active ? "pill--good" : "pill--warn"}`}>
          {merchant.active ? "Live" : "Paused"}
        </span>
      </div>
      <p className="muted small">
        Razorpay key <code>{pub.razorpay_key_id_masked}</code> · contacting{" "}
        {merchant.contact_window_start.slice(0, 5)}–
        {merchant.contact_window_end.slice(0, 5)} {merchant.timezone} · up to{" "}
        {merchant.max_attempts} attempts · {merchant.channels_enabled.join(", ")}
      </p>

      {/* ── headline numbers ── */}
      <div className="grid grid--stats" style={{ marginTop: 28 }}>
        <div className="card">
          <div className="stat__label">Recovered</div>
          <div className="stat__value" style={{ color: "var(--good)" }}>
            {formatINR(stats.amount_recovered)}
          </div>
          <div className="stat__sub">
            {stats.recovered} of {stats.total_events} events · last 30 days
          </div>
        </div>
        <div className="card">
          <div className="stat__label">Recovery rate</div>
          <div className="stat__value">{stats.recovery_rate}%</div>
          <div className="stat__sub">of events the agent has acted on</div>
        </div>
        <div className="card">
          <div className="stat__label">Still at risk</div>
          <div className="stat__value">{formatINR(stats.amount_at_risk)}</div>
          <div className="stat__sub">{stats.open} events in flight</div>
        </div>
        <div className="card">
          <div className="stat__label">Needs a human</div>
          <div className="stat__value">{stats.stopped}</div>
          <div className="stat__sub">stopped or escalated</div>
        </div>
      </div>

      {/* ── root cause insight ── */}
      <section className="section">
        <div className="section__head">
          <h2>Why payments failed this week</h2>
          <span className="muted small">
            the pattern behind the number, and what fixes it
          </span>
        </div>
        {reasons.length === 0 ? (
          <div className="card empty">
            No failures recorded yet. This fills in as events arrive.
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Cause</th>
                  <th className="num">Events</th>
                  <th className="num">Value</th>
                  <th className="num">Recovered</th>
                  <th>What fixes it</th>
                </tr>
              </thead>
              <tbody>
                {reasons.map((r) => (
                  <tr key={r.reason}>
                    <td>
                      <strong>{r.label}</strong>
                      <div className="muted small">
                        <code>{r.reason}</code>
                      </div>
                    </td>
                    <td className="num">{r.event_count}</td>
                    <td className="num">{formatINR(r.amount_total)}</td>
                    <td className="num">{r.recovered_count}</td>
                    <td className="muted small" style={{ maxWidth: 340 }}>
                      {r.remedy}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── audit trail ── */}
      <section className="section">
        <div className="section__head">
          <h2>What the agent did</h2>
          <span className="muted small">
            every action, including the ones it decided against
          </span>
        </div>
        {audit.length === 0 ? (
          <div className="card empty">
            Nothing yet. Actions appear here the moment the worker processes an
            event.
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Customer</th>
                  <th>Action</th>
                  <th>Outcome</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((a) => (
                  <tr key={a.id}>
                    <td className="muted small" style={{ whiteSpace: "nowrap" }}>
                      {timeAgo(a.created_at)}
                    </td>
                    <td>
                      {a.customer_name ?? <span className="muted">unknown</span>}
                      <div className="muted small">
                        {a.event_type} · {formatINR(a.amount)}
                      </div>
                    </td>
                    <td>
                      {a.channel ? (
                        <span className="pill pill--accent">{a.channel}</span>
                      ) : (
                        <span className="muted small">no message</span>
                      )}
                      <div className="muted small" style={{ marginTop: 4 }}>
                        {a.intervention}
                      </div>
                    </td>
                    <td>
                      <span
                        className={`pill ${OUTCOME_PILL[a.outcome] ?? "pill--info"}`}
                      >
                        {a.outcome}
                      </span>
                    </td>
                    <td style={{ maxWidth: 400 }}>
                      <div className="small">{a.rationale}</div>
                      {a.guardrail && (
                        <div
                          className="muted small"
                          style={{ marginTop: 5, fontStyle: "italic" }}
                        >
                          guardrail: {a.guardrail}
                        </div>
                      )}
                      {a.message && (
                        <details style={{ marginTop: 6 }}>
                          <summary className="muted small" style={{ cursor: "pointer" }}>
                            message sent
                          </summary>
                          <div
                            className="small"
                            style={{
                              marginTop: 6,
                              whiteSpace: "pre-wrap",
                              color: "var(--text-2)",
                            }}
                          >
                            {a.message}
                          </div>
                        </details>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="grid grid--2 section">
        {/* ── channels ── */}
        <div>
          <div className="section__head">
            <h2>Channels</h2>
          </div>
          {channels.length === 0 ? (
            <div className="card empty">Nothing sent yet.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Channel</th>
                    <th className="num">Sent</th>
                    <th className="num">Failed</th>
                  </tr>
                </thead>
                <tbody>
                  {channels.map((c) => (
                    <tr key={c.channel}>
                      <td>{c.channel}</td>
                      <td className="num">{c.sent}</td>
                      <td className="num">{c.failed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ── recent events ── */}
        <div>
          <div className="section__head">
            <h2>Recent events</h2>
          </div>
          {events.length === 0 ? (
            <div className="card empty">
              Waiting for your first event.{" "}
              <Link href="/docs">Check your webhook setup</Link>.
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Cause</th>
                    <th className="num">Amount</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e) => (
                    <tr key={e.id}>
                      <td className="small">{e.type}</td>
                      <td className="small muted">{e.reason ?? "-"}</td>
                      <td className="num">{formatINR(e.amount)}</td>
                      <td>
                        <span
                          className={`pill ${STATUS_PILL[e.status] ?? "pill--info"}`}
                        >
                          {e.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <section className="section">
        <div className="card">
          <h3>Your webhook endpoint</h3>
          <p className="muted small">
            This is the URL Razorpay posts to. It is unique to your business.
          </p>
          <pre>
            <code>{pub.webhook_url}</code>
          </pre>
        </div>
      </section>
    </div>
  );
}
