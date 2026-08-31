/**
 * Customers: the case table on its own page.
 *
 * Loads the same board payload the Overview does - this page reads the rows,
 * that one reads the aggregates - so both stay on one query path and one
 * live stream rather than diverging into two.
 */
import { notFound } from "next/navigation";

import { resolveMerchant } from "@/lib/merchants";
import { loadDashboard, rangeDays } from "@/lib/board";
import { Customers } from "@/components/customers";

export const dynamic = "force-dynamic";

export default async function CustomersPage({
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

  return (
    <Customers
      slug={merchant.slug}
      initial={await loadDashboard(merchant.id, days)}
    />
  );
}
