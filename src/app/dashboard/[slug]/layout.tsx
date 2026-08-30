/**
 * The dashboard shell: identity, navigation, and the agent's own status.
 *
 * Everything inside is server-rendered. The merchant is resolved once here and
 * again in the page - Next dedupes the two within a render pass, and the
 * alternative (threading it through context) would stop each page rendering on
 * its own.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { resolveMerchant } from "@/lib/merchants";
import { todayStats } from "@/lib/board";
import { DashboardNav, type NavItem } from "@/components/dashboard-nav";
import { ThemeToggle } from "@/components/theme-toggle";

export const dynamic = "force-dynamic";

/**
 * Applied before first paint, so a remembered dark choice never shows as a
 * flash of light first. Light is the default: no stored choice means light,
 * whatever the operating system prefers.
 */
const THEME_BOOTSTRAP = `try{var t=localStorage.getItem("tally-theme");if(t==="dark")document.documentElement.dataset.theme="dark";}catch(e){}`;

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
  const today = await todayStats(merchant.id).catch(() => null);

  // One dataset, viewed several ways, is one page. Filtering by status is what
  // a separate Events list was; the table is what a Customers list was; and
  // the timeline behind a row is what an activity feed was.
  const items: NavItem[] = [
    { href: base, label: "Overview", icon: "◧" },
    { href: `${base}/settings`, label: "Settings", icon: "⚙" },
  ];

  const initials = merchant.business_name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      <div className="app">
        <aside className="app__side">
          <Link href="/" className="brand">
            <span className="brand__mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18">
                <path
                  d="M12 2.6 21 7.6v8.8L12 21.4 3 16.4V7.6l9-5Z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinejoin="round"
                />
                <path
                  d="M7.6 12.4l3 3 5.8-6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className="brand__text">
              <span className="brand__eyebrow">AI revenue</span>
              <span className="brand__name">Tally</span>
            </span>
          </Link>

          <DashboardNav items={items} />

          <div className="app__side-foot">
            {/* ── the agent's own status, from real counts ── */}
            <div className="agentcard">
              <div className="agentcard__head">
                <span className="agentcard__title">Agent status</span>
                <span
                  className={`agentcard__state${merchant.active ? "" : " is-paused"}`}
                >
                  <i aria-hidden="true" />
                  {merchant.active ? "Live" : "Paused"}
                </span>
              </div>
              <dl className="agentcard__rows">
                <div>
                  <dt>Interventions today</dt>
                  <dd>{today?.interventions_today ?? 0}</dd>
                </div>
                <div>
                  <dt>Recovery rate today</dt>
                  <dd>
                    {today?.recovery_rate_today === null ||
                    today?.recovery_rate_today === undefined
                      ? "—"
                      : `${today.recovery_rate_today}%`}
                  </dd>
                </div>
                <div>
                  <dt>Events today</dt>
                  <dd>{today?.events_today ?? 0}</dd>
                </div>
              </dl>
            </div>

            <div className="userchip">
              <span className="userchip__avatar" aria-hidden="true">
                {initials || "T"}
              </span>
              <span className="userchip__body">
                <span className="userchip__name" title={merchant.business_name}>
                  {merchant.business_name}
                </span>
                <span className="userchip__role">Merchant</span>
              </span>
              <ThemeToggle />
            </div>
          </div>
        </aside>

        <main className="app__main">{children}</main>
      </div>
    </>
  );
}
