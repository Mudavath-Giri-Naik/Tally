/**
 * The dashboard shell: identity, section nav, and the account strip.
 *
 * Everything inside is server-rendered. The merchant is resolved once here
 * and again in each page - Next dedupes the two within a render pass, and the
 * alternative (threading it through context) would make each page unable to
 * render on its own.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { resolveMerchant } from "@/lib/merchants";
import { merchantStats } from "@/lib/insights";
import { DashboardNav, type NavItem } from "@/components/dashboard-nav";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const merchant = await resolveMerchant(slug).catch(() => null);
  return {
    title: merchant ? `${merchant.business_name} · Tally` : "Dashboard · Tally",
  };
}

export default async function DashboardLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const merchant = await resolveMerchant(slug).catch(() => null);
  if (!merchant) notFound();

  // Old links carry the uuid. Keep them working, but show the merchant the
  // address they should actually be using.
  const base = `/dashboard/${merchant.slug}`;

  const stats = await merchantStats(merchant.id).catch(() => null);

  // One dataset, viewed several ways, is one page. Filtering by status is what
  // a separate Events list was; the table is what a Customers list was; and the
  // timeline behind a row is what an activity feed was. Splitting them made a
  // merchant hunt across three pages for one thing.
  const items: NavItem[] = [
    { href: base, label: "Dashboard", icon: "◧", badge: stats?.open },
    { href: `${base}/settings`, label: "Settings", icon: "⚙" },
  ];

  const initials = merchant.business_name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <div className="app">
      <aside className="app__side">
        <div className="app__brand">
          <Link href="/" className="app__brand-mark">
            Tally
          </Link>
        </div>

        <div className="orgcard">
          <span className="orgcard__avatar" aria-hidden="true">
            {initials || "T"}
          </span>
          <span className="orgcard__body">
            <span className="orgcard__name" title={merchant.business_name}>
              {merchant.business_name}
            </span>
            <span
              className={`orgcard__state${merchant.active ? "" : " is-paused"}`}
            >
              <i aria-hidden="true" />
              {merchant.active ? "Agent live" : "Agent paused"}
            </span>
          </span>
        </div>

        <DashboardNav items={items} />

        <div className="app__side-foot">
          <Link href="/docs">Documentation</Link>
          <Link href="/onboarding">Add a business</Link>
        </div>
      </aside>

      <main className="app__main">{children}</main>
    </div>
  );
}
