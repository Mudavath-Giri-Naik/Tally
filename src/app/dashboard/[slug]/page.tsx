/**
 * The recovery board — the dashboard's default view.
 *
 * Rendered on the server with real numbers so the page is correct before any
 * JavaScript runs, then handed to a client component that keeps it current
 * from the SSE stream. The board is one row per event; Events and Customers
 * remain as the deeper, searchable lists behind it.
 */
import Link from "next/link";
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
  const base = `/dashboard/${merchant.slug}`;

  return (
    <>
      <PageHead
        title="Recovery board"
        lede={`Last 90 days · ${merchant.business_name}`}
        actions={
          <Link className="btn btn--ghost" href={`${base}/events`}>
            Search all events
          </Link>
        }
      />

      <LiveBoard slug={merchant.slug} initial={board} />
    </>
  );
}
