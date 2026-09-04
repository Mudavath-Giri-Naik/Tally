/**
 * Workflows: which recovery categories run, and what each has done.
 *
 * Loaded over the widest window the dashboard offers - a workflow's stats
 * should reflect what it has actually recovered lately, not just today.
 */
import { notFound } from "next/navigation";

import { resolveMerchant } from "@/lib/merchants";
import { loadDashboard } from "@/lib/board";
import { Workflows } from "@/components/workflows";

export const dynamic = "force-dynamic";

export default async function WorkflowsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const merchant = await resolveMerchant(slug).catch(() => null);
  if (!merchant) notFound();

  return (
    <Workflows
      slug={merchant.slug}
      merchantId={merchant.id}
      initial={await loadDashboard(merchant.id, 90)}
    />
  );
}
