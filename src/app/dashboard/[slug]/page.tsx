/**
 * The dashboard. One page, one dataset, several ways of looking at it.
 *
 * Rendered on the server with real numbers so the page is correct before any
 * JavaScript runs, then handed to a client component that keeps it current
 * from the SSE stream.
 *
 * This replaced three separate pages. Filtering by status tab is what an
 * Events list did; the table is what a Customers list did; the timeline behind
 * a row is what an activity feed did. They were one dataset all along, and
 * making a merchant navigate between them to assemble the picture was the
 * cost of pretending otherwise.
 */
import { notFound } from "next/navigation";
import { resolveMerchant } from "@/lib/merchants";
import { loadBoard } from "@/lib/board";
import { PageHead } from "@/components/ui";
import { LiveBoard } from "@/components/live-board";

export const dynamic = "force-dynamic";

export default async function BoardPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const merchant = await resolveMerchant(slug).catch(() => null);
  if (!merchant) notFound();

  const board = await loadBoard(merchant.id);

  return (
    <>
      <PageHead
        title="Dashboard"
        lede={`Last 90 days · ${merchant.business_name}`}
      />

      <LiveBoard slug={merchant.slug} initial={board} />
    </>
  );
}
