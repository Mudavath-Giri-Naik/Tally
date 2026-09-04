/**
 * Inbox: the queue, on its own page.
 *
 * Loaded over the widest window the dashboard offers, deliberately - the
 * whole point of this tab is surfacing a case regardless of how long ago it
 * failed, and a merchant should never have to widen a date range to find out
 * something is still waiting on them.
 */
import { notFound } from "next/navigation";

import { resolveMerchant } from "@/lib/merchants";
import { loadDashboard } from "@/lib/board";
import { Inbox } from "@/components/inbox";

export const dynamic = "force-dynamic";

export default async function InboxPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const merchant = await resolveMerchant(slug).catch(() => null);
  if (!merchant) notFound();

  return <Inbox slug={merchant.slug} initial={await loadDashboard(merchant.id, 90)} />;
}
