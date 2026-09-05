/**
 * Audit Trail: the page shell.
 *
 * Only the customer list for the filter dropdown is loaded here - the rows
 * themselves are fetched and paginated by the client component, since a page
 * change is a filter change, not a navigation.
 */
import { notFound } from "next/navigation";

import { resolveMerchant } from "@/lib/merchants";
import { customerRows, channelPerformance } from "@/lib/insights";
import { merchantInvariants, merchantSendHours } from "@/lib/evidence";
import { AuditTrail } from "@/components/audit-trail";

export const dynamic = "force-dynamic";

// Thirty days for the compliance summary at the top - a control arm and a
// send-hours histogram both need volume before they say anything, and a
// week is not the window anyone asks "did it behave" over. The row list
// below is unbounded regardless; only this summary is windowed.
const SUMMARY_DAYS = 30;

export default async function AuditPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const merchant = await resolveMerchant(slug).catch(() => null);
  if (!merchant) notFound();

  const since = new Date(Date.now() - SUMMARY_DAYS * 86_400_000).toISOString();
  const window = {
    start: merchant.contact_window_start,
    end: merchant.contact_window_end,
  };

  const [customers, invariants, hours, channels] = await Promise.all([
    customerRows(merchant.id, 500).catch(() => []),
    merchantInvariants(merchant.id, since),
    merchantSendHours(merchant.id, since, window),
    channelPerformance(merchant.id, SUMMARY_DAYS).catch(() => []),
  ]);

  return (
    <AuditTrail
      slug={merchant.slug}
      customers={customers.map((c) => ({ id: c.id, name: c.name }))}
      invariants={invariants}
      hours={hours}
      channels={channels}
      window={window}
      timezone={merchant.timezone}
    />
  );
}
