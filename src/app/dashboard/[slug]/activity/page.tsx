/**
 * Agent activity: the full audit trail.
 *
 * The decisions the agent made *against* acting are the ones worth reading -
 * a message that went out is visible in the customer's inbox, but a message
 * that was correctly withheld is only visible here. So the filter defaults to
 * everything, and the rationale gets the widest column on the page.
 */
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { resolveMerchant } from "@/lib/merchants";
import { auditTrail, actionSummary } from "@/lib/insights";
import { formatINR } from "@/lib/types";
import { PageHead, StatusPill, EmptyState, timeAgo } from "@/components/ui";
import { FilterBar } from "@/components/filter-bar";

export const dynamic = "force-dynamic";

const OUTCOMES = [
  "sent",
  "delivered",
  "failed",
  "escalated",
  "skipped",
  "no_action",
  "pending",
];
const CHANNELS = ["email", "whatsapp", "voice", "none"];

function human(value: string): string {
  return value.replace(/_/g, " ");
}

export default async function ActivityPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const merchant = await resolveMerchant(slug).catch(() => null);
  if (!merchant) notFound();

  const one = (k: string) =>
    (Array.isArray(sp[k]) ? sp[k][0] : sp[k]) as string | undefined;

  const outcome = OUTCOMES.includes(one("outcome") ?? "") ? one("outcome") : undefined;
  const channel = CHANNELS.includes(one("channel") ?? "") ? one("channel") : undefined;

  const [rows, summary] = await Promise.all([
    auditTrail(merchant.id, 100, { outcome, channel }),
    actionSummary(merchant.id),
  ]);

  const sent = (summary.sent ?? 0) + (summary.delivered ?? 0);
  const withheld = (summary.skipped ?? 0) + (summary.no_action ?? 0);

  return (
    <>
      <PageHead
        title="Agent activity"
        lede="Every action, including the ones the agent decided against."
      />

      <div className="statgrid statgrid--tight">
        <div className="statcard">
          <div className="statcard__label">Messages sent</div>
          <div className="statcard__value is-good">{sent}</div>
          <div className="statcard__foot">
            <span className="statcard__sub">last 30 days</span>
          </div>
        </div>
        <div className="statcard">
          <div className="statcard__label">Withheld</div>
          <div className="statcard__value">{withheld}</div>
          <div className="statcard__foot">
            <span className="statcard__sub">a guardrail stopped it</span>
          </div>
        </div>
        <div className="statcard">
          <div className="statcard__label">Escalated</div>
          <div
            className={`statcard__value${(summary.escalated ?? 0) > 0 ? " is-warn" : ""}`}
          >
            {summary.escalated ?? 0}
          </div>
          <div className="statcard__foot">
            <span className="statcard__sub">handed to a person</span>
          </div>
        </div>
        <div className="statcard">
          <div className="statcard__label">Send failures</div>
          <div
            className={`statcard__value${(summary.failed ?? 0) > 0 ? " is-bad" : ""}`}
          >
            {summary.failed ?? 0}
          </div>
          <div className="statcard__foot">
            <span className="statcard__sub">the channel rejected it</span>
          </div>
        </div>
      </div>

      <Suspense fallback={<div className="filterbar" />}>
        <FilterBar
          filters={[
            {
              name: "outcome",
              label: "Outcome",
              options: OUTCOMES.map((o) => ({ value: o, label: human(o) })),
            },
            {
              name: "channel",
              label: "Channel",
              options: CHANNELS.map((c) => ({
                value: c,
                label: c === "none" ? "no message" : c,
              })),
            },
          ]}
        />
      </Suspense>

      {rows.length === 0 ? (
        <EmptyState
          title="Nothing here"
          body="No action matches these filters. The agent writes a row for every decision it makes, including the ones where it chose to do nothing."
        />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Customer</th>
                <th>Decision</th>
                <th>Outcome</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td className="muted small nowrap">{timeAgo(a.created_at)}</td>
                  <td>
                    <div className="cell-name">
                      {a.customer_name ?? <span className="muted">Unknown</span>}
                    </div>
                    <div className="muted small">
                      {human(a.event_type)} · {formatINR(a.amount)}
                    </div>
                  </td>
                  <td>
                    {a.channel ? (
                      <span className="tag">{a.channel}</span>
                    ) : (
                      <span className="tag tag--quiet">no message</span>
                    )}
                    {a.intervention && (
                      <div className="muted small" style={{ marginTop: 5 }}>
                        {human(a.intervention)}
                      </div>
                    )}
                  </td>
                  <td>
                    <StatusPill value={a.outcome} />
                  </td>
                  <td className="why">
                    <div className="small">{a.rationale}</div>
                    {a.guardrail && (
                      <div className="guardrail">
                        guardrail: {human(a.guardrail)}
                      </div>
                    )}
                    {a.message && (
                      <details className="msg">
                        <summary>Message sent</summary>
                        <div className="msg__body">{a.message}</div>
                      </details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
