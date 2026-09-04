/**
 * The Overview. One page, one dataset, several ways of looking at it.
 *
 * Rendered on the server for the selected window so the figures are correct
 * before any JavaScript runs, then handed to a client component that keeps
 * them current from the SSE stream.
 */
import { notFound } from "next/navigation";
import { resolveMerchant } from "@/lib/merchants";
import { loadDashboard, rangeDays } from "@/lib/board";
import { merchantLift, merchantSpend, merchantCauses } from "@/lib/evidence";
import { Overview } from "@/components/overview";

export const dynamic = "force-dynamic";

export default async function OverviewPage({
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

  const raw = Array.isArray(sp.range) ? sp.range[0] : sp.range;
  const days = rangeDays(raw);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const [initial, lift, spend, causes] = await Promise.all([
    loadDashboard(merchant.id, days),
    merchantLift(merchant.id, since),
    merchantSpend(merchant.id, since),
    merchantCauses(merchant.id, since),
  ]);

  return <Overview slug={merchant.slug} initial={initial} lift={lift} spend={spend} causes={causes} />;
}
