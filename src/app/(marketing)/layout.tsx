import Link from "next/link";
import { ShieldCheckIcon, ArrowRightIcon } from "lucide-react";

/**
 * The public pages: landing, docs, onboarding.
 *
 * A route group, so the URLs are unchanged - `/docs` is still `/docs`. This
 * exists only to give these three a top bar without the dashboard inheriting
 * it. Styled to match the homepage's own navbar mark rather than the plain
 * flat bar these pages used to open on - a visitor going from the front page
 * to the setup guide should not feel like they left the product.
 */
export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <header className="sticky top-0 z-10 border-b border-neutral-200 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-[1080px] items-center justify-between gap-6 px-6 py-3.5">
          <Link href="/" className="flex shrink-0 items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-[0.35rem] bg-[#1a1a1a] text-white">
              <ShieldCheckIcon className="size-3.5" strokeWidth={2.5} />
            </span>
            <span className="text-base font-bold tracking-tight text-neutral-900">
              Tally
            </span>
          </Link>

          <nav className="flex items-center gap-6 text-sm font-semibold text-neutral-600">
            <Link href="/docs" className="transition-colors hover:text-neutral-900">
              Docs
            </Link>
            <Link
              href="/onboarding"
              className="flex items-center gap-1.5 rounded-full bg-gradient-to-b from-[#3a3a3a] to-[#121212] py-1.5 pr-1 pl-3.5 text-sm text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] transition hover:from-[#4a4a4a] hover:to-[#222]"
            >
              Connect
              <span className="flex size-5 items-center justify-center rounded-full bg-white text-neutral-900">
                <ArrowRightIcon className="size-3" strokeWidth={3} />
              </span>
            </Link>
          </nav>
        </div>
      </header>
      <main>{children}</main>
    </>
  );
}
