import Link from "next/link";

/**
 * The public pages: landing, docs, onboarding.
 *
 * A route group, so the URLs are unchanged - `/docs` is still `/docs`. This
 * exists only to give these three a top bar without the dashboard inheriting
 * it.
 */
export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <header className="topbar">
        <div className="topbar__inner">
          <Link href="/" className="topbar__brand">
            Tally
          </Link>
          <nav className="topbar__nav">
            <Link href="/docs">Docs</Link>
            <Link href="/onboarding">Connect</Link>
          </nav>
        </div>
      </header>
      <main>{children}</main>
    </>
  );
}
