/**
 * Audit Trail: the page shell.
 *
 * Only the customer list for the filter dropdown is loaded here - the rows
 * themselves are fetched and paginated by the client component, since a page
 * change is a filter change, not a navigation.
 */
import { notFound } from "next/navigation";

import { resolveMerchant } from "@/lib/merchants";
import { customerRows } from "@/lib/insights";
import { AuditTrail } from "@/components/audit-trail";

export const dynamic = "force-dynamic";

export default async function AuditPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const merchant = await resolveMerchant(slug).catch(() => null);
  if (!merchant) notFound();

  const customers = await customerRows(merchant.id, 500).catch(() => []);

  return (
    <AuditTrail
      slug={merchant.slug}
      customers={customers.map((c) => ({ id: c.id, name: c.name }))}
    />
  );
}
