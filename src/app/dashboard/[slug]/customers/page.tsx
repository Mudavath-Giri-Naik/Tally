/**
 * Customers.
 *
 * Sorted by most recent activity, because the useful question is "who is
 * failing right now", not "who signed up first". Opt-out is shown prominently:
 * it is the one row state that changes what the agent is allowed to do.
 */
import { notFound } from "next/navigation";
import { resolveMerchant } from "@/lib/merchants";
import { customerRows } from "@/lib/insights";
import { formatINR } from "@/lib/types";
import { PageHead, EmptyState, Panel, timeAgo } from "@/components/ui";
import { InlineBar } from "@/components/charts";

export const dynamic = "force-dynamic";

export default async function CustomersPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const merchant = await resolveMerchant(slug).catch(() => null);
  if (!merchant) notFound();

  const customers = await customerRows(merchant.id, 200);

  const optedOut = customers.filter((c) => c.opted_out).length;
  const repeat = customers.filter((c) => c.total_events > 1).length;
  const maxRecovered = Math.max(1, ...customers.map((c) => c.amount_recovered));

  return (
    <>
      <PageHead
        title="Customers"
        lede={`${customers.length} people Tally has handled a payment for.`}
      />

      {customers.length === 0 ? (
        <EmptyState
          title="No customers yet"
          body="A customer record is created the first time one of their payments fails. Nothing to show until then."
        />
      ) : (
        <>
          <div className="statgrid statgrid--tight">
            <div className="statcard">
              <div className="statcard__label">Total</div>
              <div className="statcard__value">{customers.length}</div>
              <div className="statcard__foot">
                <span className="statcard__sub">with at least one event</span>
              </div>
            </div>
            <div className="statcard">
              <div className="statcard__label">Repeat failures</div>
              <div className={`statcard__value${repeat > 0 ? " is-warn" : ""}`}>
                {repeat}
              </div>
              <div className="statcard__foot">
                <span className="statcard__sub">more than one event</span>
              </div>
            </div>
            <div className="statcard">
              <div className="statcard__label">Opted out</div>
              <div className="statcard__value">{optedOut}</div>
              <div className="statcard__foot">
                <span className="statcard__sub">will never be contacted</span>
              </div>
            </div>
          </div>

          <Panel
            title="Everyone"
            hint="Most recent activity first."
            flush
          >
            <div className="table-wrap table-wrap--flush">
              <table>
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Reachable on</th>
                    <th className="num">Events</th>
                    <th>Recovered</th>
                    <th className="num">At risk</th>
                    <th>Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {customers.map((c) => (
                    <tr key={c.id} className={c.opted_out ? "is-muted" : undefined}>
                      <td>
                        <div className="cell-name">
                          {c.name ?? <span className="muted">Unnamed</span>}
                          {c.opted_out && (
                            <span className="pill pill--warn">opted out</span>
                          )}
                          {c.total_events > 2 && !c.opted_out && (
                            <span className="pill pill--info">repeat</span>
                          )}
                        </div>
                      </td>
                      <td className="small muted">
                        {c.email && <div>{c.email}</div>}
                        {c.phone && <div>{c.phone}</div>}
                        {!c.email && !c.phone && <span>no contact on file</span>}
                      </td>
                      <td className="num">
                        {c.total_events}
                        {c.open_events > 0 && (
                          <div className="muted small">{c.open_events} open</div>
                        )}
                      </td>
                      <td style={{ minWidth: 150 }}>
                        <div className="barcell">
                          <span className="barcell__num">
                            {formatINR(c.amount_recovered)}
                          </span>
                          <InlineBar
                            value={c.amount_recovered}
                            max={maxRecovered}
                          />
                        </div>
                      </td>
                      <td className="num">{formatINR(c.amount_at_risk)}</td>
                      <td className="muted small nowrap">
                        {timeAgo(c.last_event_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      )}
    </>
  );
}
