import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import "./globals.css";

/**
 * The theme's type tokens are `--font-sans: var(--font-geist-sans)` and
 * `--font-mono: var(--font-geist-mono)`, so the faces have to be loaded and
 * those variables defined here. Without them the tokens resolve to nothing,
 * every `font-sans` utility falls through, and the whole app renders in the
 * browser's default serif.
 */
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Tally - AI revenue recovery",
  description:
    "Connect Razorpay once. Tally listens for failed payments, works out why they failed, and recovers them on its own.",
};

/**
 * The root layout carries the document, the fonts and the stylesheet, and
 * nothing else.
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
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
