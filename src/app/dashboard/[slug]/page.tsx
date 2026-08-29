/**
 * Overview.
 *
 * The question this page answers is "is the agent earning its keep, and what
 * should I look at next" - so it leads with money, then the trend, then the
 * two things a merchant can act on: the causes behind the failures, and the
 * cases the agent handed back.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { resolveMerchant } from "@/lib/merchants";
import {
  statsWithTrend,
  failureReasons,
  channelPerformance,
  auditTrail,
  dailySeries,
  actionSummary,
} from "@/lib/insights";
import { formatINR } from "@/lib/types";
import { PageHead, StatCard, StatusPill, Panel, EmptyState, timeAgo } from "@/components/ui";
import { DailyRecoveryChart, StatusDonut, InlineBar } from "@/components/charts";

export const dynamic = "force-dynamic";

export default async function OverviewPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const merchant = await resolveMerchant(slug).catch(() => null);
  if (!merchant) notFound();

  const base = `/dashboard/${merchant.slug}`;

  const [stats, reasons, channels, audit, series, actions] = await Promise.all([
    statsWithTrend(merchant.id),
    failureReasons(merchant.id, 7),
    channelPerformance(merchant.id),
    auditTrail(merchant.id, 8),
    dailySeries(merchant.id, 14),
    actionSummary(merchant.id),
  ]);

  const hasData = stats.total_events > 0;
  const escalated = actions.escalated ?? 0;
  const maxReason = Math.max(1, ...reasons.map((r) => r.amount_total));

  // "Written off" is what the agent gave up on for good. `stopped` is
  // deliberately not in here - that is a pause a human can undo, so counting
  // it as lost money would overstate the loss.
  const lost = stats.amount_unrecoverable;

  return (
    <>
      <PageHead
        title="Overview"
        lede={`Last 30 days · ${merchant.business_name}`}
        actions={
          <Link className="btn btn--ghost" href={`${base}/events`}>
            View all events
          </Link>
        }
      />

      {!hasData && (
        <div className="callout" style={{ marginBottom: 24 }}>
          <strong>No events yet.</strong> Tally is connected and listening. The
          first failed payment on your Razorpay account will appear here within
          a minute, already classified.{" "}
          <Link href={`${base}/settings`}>Check your webhook setup</Link>.
        </div>
      )}

      <div className="statgrid">
        <StatCard
          label="Recovered"
          value={formatINR(stats.amount_recovered)}
          sub={`${stats.recovered} of ${stats.total_events} events`}
          delta={stats.recovered_delta_pct}
          tone="good"
        />
        <StatCard
          label="Recovery rate"
          value={`${stats.recovery_rate}%`}
          sub="of events acted on"
          delta={stats.rate_delta_points}
          deltaSuffix=" pts"
        />
        <StatCard
          label="Still at risk"
          value={formatINR(stats.amount_at_risk)}
          sub={`${stats.open} events in flight`}
        />
        {/* Events, not events + escalations: an escalation is an action on an
            event that is very likely already counted as stopped, so adding the
            two would double-count the same case. */}
        <StatCard
          label="Needs a human"
          value={String(stats.stopped)}
          sub={
            escalated > 0
              ? `${escalated} escalation${escalated === 1 ? "" : "s"} recorded`
              : "events the agent stopped"
          }
          tone={stats.stopped > 0 ? "warn" : undefined}
        />
      </div>

      <div className="grid2">
        <Panel
          title="Recovery over time"
          hint="Money recovered against money still outstanding, by day."
        >
          <DailyRecoveryChart
            data={series.map((d) => ({
              day: d.day,
              recovered: d.amount_recovered,
              at_risk: d.amount_at_risk,
            }))}
          />
        </Panel>

        <Panel title="Where the money stands" hint="Across the last 30 days.">
          <StatusDonut
            total={formatINR(stats.amount_recovered + stats.amount_at_risk)}
            caption="in scope"
            slices={[
              { key: "recovered", label: "Recovered", value: stats.amount_recovered },
              { key: "at_risk", label: "Still in flight", value: stats.amount_at_risk },
              { key: "lost", label: "Written off", value: lost },
            ]}
          />
        </Panel>
      </div>

      <Panel
        title="Why payments failed this week"
        hint="The pattern behind the number, and what actually fixes it."
        flush
      >
        {reasons.length === 0 ? (
          <EmptyState
            title="No failures recorded yet"
            body="This fills in as events arrive. Each cause comes with the fix that works for it."
          />
        ) : (
          <div className="table-wrap table-wrap--flush">
            <table>
              <thead>
                <tr>
                  <th>Cause</th>
                  <th className="num">Events</th>
                  <th>Value at stake</th>
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
                    <td style={{ minWidth: 160 }}>
                      <div className="barcell">
                        <span className="barcell__num">
                          {formatINR(r.amount_total)}
                        </span>
                        <InlineBar
                          value={r.amount_total}
                          max={maxReason}
                          tone="at_risk"
                        />
                      </div>
                    </td>
                    <td className="num">{r.recovered_count}</td>
                    <td className="muted small remedy">{r.remedy}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="grid2">
        <Panel
          title="Recent agent activity"
          hint="Including the actions it decided against."
          action={
            <Link className="panel__link" href={`${base}/activity`}>
              Full trail →
            </Link>
          }
          flush
        >
          {audit.length === 0 ? (
            <EmptyState
              title="Nothing yet"
              body="Actions appear the moment the worker processes its first event."
            />
          ) : (
            <ul className="feed">
              {audit.map((a) => (
                <li key={a.id} className="feed__item">
                  <div className="feed__top">
                    <span className="feed__who">
                      {a.customer_name ?? "Unknown customer"}
                    </span>
                    <StatusPill value={a.outcome} />
                    <span className="feed__when">{timeAgo(a.created_at)}</span>
                  </div>
                  <div className="feed__why">{a.rationale}</div>
                  <div className="feed__meta">
                    {a.channel ? (
                      <span className="tag">{a.channel}</span>
                    ) : (
                      <span className="tag tag--quiet">no message</span>
                    )}
                    {a.intervention && <span className="tag">{a.intervention}</span>}
                    <span className="muted small">{formatINR(a.amount)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="Channels"
          hint="Which route is actually reaching people."
          flush
        >
          {channels.length === 0 ? (
            <EmptyState
              title="Nothing sent yet"
              body="Channel performance appears once the agent has sent its first message."
            />
          ) : (
            <div className="table-wrap table-wrap--flush">
              <table>
                <thead>
                  <tr>
                    <th>Channel</th>
                    <th className="num">Sent</th>
                    <th className="num">Failed</th>
                    <th className="num">Recovered</th>
                  </tr>
                </thead>
                <tbody>
                  {channels.map((c) => (
                    <tr key={c.channel}>
                      <td>
                        <span className="tag">{c.channel}</span>
                      </td>
                      <td className="num">{c.sent}</td>
                      <td className="num">{c.failed}</td>
                      <td className="num">{c.recovered}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
