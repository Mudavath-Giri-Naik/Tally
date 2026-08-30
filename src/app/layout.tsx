import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tally - AI revenue recovery",
  description:
    "Connect Razorpay once. Tally listens for failed payments, works out why they failed, and recovers them on its own.",
};

/**
 * The root layout carries the document and the stylesheet, and nothing else.
 *
 * Chrome lives one level down, because the two halves of the app do not share
 * any: the marketing pages get a top bar (see `(marketing)/layout.tsx`), and
 * the dashboard gets a sidebar. Putting either here would render both on the
 * pages that only want one.
 */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
