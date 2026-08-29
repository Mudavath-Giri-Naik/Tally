/**
 * Events: every recovery case, filterable.
 *
 * Filters and the page number come from the query string, so this stays a
 * server-rendered table - the filter row is the only client code on the page.
 */
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { resolveMerchant } from "@/lib/merchants";
import { listEventsFiltered } from "@/lib/events";
import { profileFor } from "@/lib/classify";
import { formatINR, type EventStatus, type EventType } from "@/lib/types";
import { PageHead, StatusPill, EmptyState, timeAgo } from "@/components/ui";
import { FilterBar, Pager } from "@/components/filter-bar";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

const STATUSES: EventStatus[] = [
  "queued",
  "processing",
  "recovered",
  "stopped",
  "unrecoverable",
];
const TYPES: EventType[] = [
  "payment_failed",
  "subscription_failed",
  "cart_abandoned",
  "promise_to_pay",
  "receivable_overdue",
  "mandate_retry",
];

function human(value: string): string {
  return value.replace(/_/g, " ");
}

/** Only accept a value the database understands - the query string is input. */
function pick<T extends string>(value: string | undefined, allowed: readonly T[]) {
  return value && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

export default async function EventsPage({
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

  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k][0] : sp[k]) as string | undefined;
  const page = Math.max(1, Number(one("page") ?? 1) || 1);

  const { rows, total } = await listEventsFiltered(merchant.id, {
    status: pick(one("status"), STATUSES),
    type: pick(one("type"), TYPES),
    search: one("q"),
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  return (
    <>
      <PageHead
        title="Events"
        lede="Every payment Tally has been asked to recover, newest first."
      />

      <Suspense fallback={<div className="filterbar" />}>
        <FilterBar
          searchPlaceholder="Search by customer name, email or phone"
          filters={[
            {
              name: "status",
              label: "Status",
              options: STATUSES.map((s) => ({ value: s, label: human(s) })),
            },
            {
              name: "type",
              label: "Type",
              options: TYPES.map((t) => ({ value: t, label: human(t) })),
            },
          ]}
        />
      </Suspense>

      {rows.length === 0 ? (
        <EmptyState
          title="No events match"
          body={
            total === 0
              ? "Nothing has arrived from Razorpay yet. Once a payment fails, it lands here within a minute."
              : "Nothing matches these filters. Try clearing one."
          }
        />
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Type</th>
                  <th>Cause</th>
                  <th className="num">Amount</th>
                  <th className="num">Attempts</th>
                  <th>Status</th>
                  <th>Age</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => {
                  const profile = e.reason ? profileFor(e.reason) : null;
                  return (
                    <tr key={e.id}>
                      <td>
                        <div className="cell-name">
                          {e.customer_name ?? (
                            <span className="muted">Unknown</span>
                          )}
                          {e.customer_opted_out && (
                            <span className="pill pill--warn">opted out</span>
                          )}
                        </div>
                        <div className="muted small">
                          {e.customer_email ?? e.customer_phone ?? "no contact"}
                        </div>
                      </td>
                      <td className="small">{human(e.type)}</td>
                      <td>
                        {profile ? (
                          <>
                            <div className="small">{profile.label}</div>
                            <div className="muted small">
                              {profile.retryable
                                ? "retryable"
                                : "needs a new method"}
                            </div>
                          </>
                        ) : (
                          <span className="muted small">unclassified</span>
                        )}
                      </td>
                      <td className="num">{formatINR(e.amount)}</td>
                      <td className="num">
                        {e.attempts}
                        <span className="muted">/{merchant.max_attempts}</span>
                      </td>
                      <td>
                        <StatusPill value={e.status} />
                        {e.stop_reason && (
                          <div className="muted small" style={{ marginTop: 4 }}>
                            {human(e.stop_reason)}
                          </div>
                        )}
                      </td>
                      <td className="muted small nowrap">
                        {timeAgo(e.created_at)}
                        {e.next_attempt_at && (
                          <div className="small">
                            next: {timeAgo(e.next_attempt_at)}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <Suspense fallback={null}>
            <Pager page={page} pageSize={PAGE_SIZE} total={total} />
          </Suspense>
        </>
      )}
    </>
  );
}
