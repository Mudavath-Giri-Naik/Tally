import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tally - AI revenue recovery",
  description:
    "Connect Razorpay once. Tally listens for failed payments, works out why they failed, and recovers them on its own.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
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
      </body>
    </html>
  );
}
