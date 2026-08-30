import Link from "next/link";
import {
  ShieldCheckIcon,
  ArrowRightIcon,
  StarIcon,
  LockIcon,
  ZapIcon,
} from "lucide-react";

import { HeroReveal } from "@/components/hero-reveal";

const FAILURE_CARDS = [
  {
    t: "Insufficient funds",
    d: "The money will exist later. Tally waits for a likely salary-credit date instead of retrying tonight and failing again.",
  },
  {
    t: "Expired or blocked card",
    d: "No retry can ever work. Tally stops retrying and asks for a different payment method instead.",
  },
  {
    t: "Gateway timeout",
    d: "The rails broke, not the customer. Tally retries quietly and apologises — it never implies they were declined.",
  },
  {
    t: "OTP not completed",
    d: "Just a slip on a busy day. A fresh link and one short nudge, with no explanation demanded.",
  },
];

const FEATURE_CARDS = [
  {
    t: "Acts, rather than labels",
    d: "It sends the message, places the call, and generates the retry link — inside the guardrails you set.",
  },
  {
    t: "Respects your rules",
    d: "A contact window, an attempt cap, and an instant stop on opt-out. A message that would land at 2am waits until morning.",
  },
  {
    t: "One message, not three",
    d: "If a customer has a failed subscription and an abandoned cart, they hear from you once, about both.",
  },
  {
    t: "Knows when to stop",
    d: "After a few failed cycles, or anything flagged by risk checks, it stops automating and hands over to a person.",
  },
  {
    t: "Shows its reasoning",
    d: "Every action records why it was taken, which rule fired, and what was sent. Nothing happens off the record.",
  },
  {
    t: "Your keys, your customers",
    d: "Your Razorpay credentials are encrypted per business and used only to act for you. Merchants are isolated from each other.",
  },
];

export default function HomePage() {
  return (
    <div className="bg-white">
      {/* ── hero: sky, navbar, headline, hills+dashboard reveal ── */}
      <div className="relative overflow-hidden bg-gradient-to-b from-sky-200 via-sky-100 to-white">
        {/* soft cloud blobs - no separate sky asset was provided, so the sky
            is built from gradients and blurred shapes instead of an image */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
          <div className="absolute -left-24 top-10 h-56 w-72 rounded-full bg-white/70 blur-3xl" />
          <div className="absolute right-[-4rem] top-24 h-64 w-80 rounded-full bg-white/60 blur-3xl" />
          <div className="absolute left-1/3 top-4 h-32 w-64 rounded-full bg-white/50 blur-2xl" />
        </div>

        <div className="relative">
          {/* ── navbar ── */}
          <header className="mx-auto max-w-6xl px-4 pt-6 sm:px-6">
            <div className="flex items-center justify-between gap-3 rounded-full border border-black/5 bg-white/90 px-4 py-2.5 shadow-lg shadow-sky-900/5 backdrop-blur sm:px-6">
              <Link href="/" className="flex shrink-0 items-center gap-2">
                <span className="flex size-8 items-center justify-center rounded-lg bg-neutral-900 text-white">
                  <ShieldCheckIcon className="size-4" />
                </span>
                <span className="text-lg font-bold tracking-tight text-neutral-900">
                  Tally
                </span>
              </Link>

              <nav className="hidden items-center gap-8 text-sm font-medium text-neutral-600 md:flex">
                <a href="#how-it-works" className="hover:text-neutral-900">
                  How it works
                </a>
                <a href="#features" className="hover:text-neutral-900">
                  Features
                </a>
                <Link href="/docs" className="hover:text-neutral-900">
                  Docs
                </Link>
              </nav>

              <Link
                href="/onboarding"
                className="flex shrink-0 items-center gap-1.5 rounded-full bg-neutral-900 py-2 pl-4 pr-1.5 text-sm font-semibold text-white transition hover:bg-neutral-800"
              >
                <span className="hidden sm:inline">Connect your business</span>
                <span className="sm:hidden">Connect</span>
                <span className="flex size-6 items-center justify-center rounded-full bg-white text-neutral-900">
                  <ArrowRightIcon className="size-3.5" />
                </span>
              </Link>
            </div>
          </header>

          {/* ── headline ── */}
          <div className="mx-auto max-w-4xl px-4 pb-8 pt-16 text-center sm:px-6 sm:pt-24">
            <h1 className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-[2.6rem] leading-[1.05] font-extrabold tracking-tight text-neutral-900 sm:text-6xl md:text-7xl">
              Revenue
              <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-neutral-800 to-neutral-950 align-middle shadow-lg sm:size-14 md:size-16">
                <ZapIcon className="size-6 text-white sm:size-7 md:size-8" fill="currentColor" />
              </span>
              Recovery
            </h1>
            <p className="mx-auto mt-6 max-w-xl text-base text-neutral-600 sm:text-lg">
              Tally watches your Razorpay account, works out <em>why</em> each
              payment actually failed, and recovers it — by email, WhatsApp, or
              a real phone call. Connect it once, then just watch the number.
            </p>

            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link
                href="/onboarding"
                className="flex w-full items-center justify-center gap-2 rounded-full bg-gradient-to-b from-sky-500 to-blue-600 px-6 py-3.5 text-base font-semibold text-white shadow-lg shadow-blue-600/30 transition hover:from-sky-400 hover:to-blue-500 sm:w-auto"
              >
                Connect your business
                <span className="flex size-6 items-center justify-center rounded-full bg-white/25">
                  <ArrowRightIcon className="size-3.5" />
                </span>
              </Link>
              <Link
                href="/dashboard/mandate-2"
                className="w-full rounded-full border border-neutral-200 bg-white px-6 py-3.5 text-center text-base font-semibold text-neutral-900 shadow-sm transition hover:bg-neutral-50 sm:w-auto"
              >
                View live demo
              </Link>
            </div>

            <div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-neutral-600">
              <span className="flex items-center gap-1.5">
                <StarIcon className="size-4 text-amber-500" fill="currentColor" />
                Guardrail-checked every send
              </span>
              <span className="hidden text-neutral-300 sm:inline">|</span>
              <span className="flex items-center gap-1.5">
                <LockIcon className="size-4 text-emerald-600" />
                AES-256 encrypted keys
              </span>
              <span className="hidden text-neutral-300 sm:inline">|</span>
              <span className="flex items-center gap-1.5">
                <ZapIcon className="size-4 text-orange-500" fill="currentColor" />
                Live within five minutes
              </span>
            </div>
          </div>

          {/* ── hills + dashboard, scroll reveal ── */}
          <HeroReveal />
          <div className="h-16 sm:h-24" />
        </div>
      </div>

      {/* ── why the reason matters ── */}
      <section id="how-it-works" className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight text-neutral-900 sm:text-4xl">
            The reason it failed is the whole product
          </h2>
          <p className="mt-4 text-neutral-600">
            Most dunning tools retry everything on the same schedule. That
            wastes gateway fees on payments that can never succeed, and annoys
            customers who did nothing wrong. Tally treats each cause
            differently.
          </p>
        </div>

        <div className="mt-12 grid gap-5 sm:grid-cols-2">
          {FAILURE_CARDS.map((c) => (
            <div
              key={c.t}
              className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm"
            >
              <h3 className="font-semibold text-neutral-900">{c.t}</h3>
              <p className="mt-2 text-sm text-neutral-600">{c.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── what it does on its own ── */}
      <section id="features" className="bg-neutral-50 py-20 sm:py-28">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-bold tracking-tight text-neutral-900 sm:text-4xl">
              What it does on its own
            </h2>
          </div>

          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURE_CARDS.map((c) => (
              <div
                key={c.t}
                className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm"
              >
                <h3 className="font-semibold text-neutral-900">{c.t}</h3>
                <p className="mt-2 text-sm text-neutral-600">{c.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── closing cta ── */}
      <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
        <div className="rounded-3xl border border-neutral-200 bg-gradient-to-b from-white to-neutral-50 px-6 py-14 text-center shadow-sm sm:px-12">
          <h2 className="text-3xl font-bold tracking-tight text-neutral-900 sm:text-4xl">
            Connect once. Then just watch.
          </h2>
          <p className="mx-auto mt-3 max-w-md text-neutral-600">
            Setup is a Razorpay key, a webhook URL, and the hours you are happy
            for customers to be contacted.
          </p>
          <Link
            href="/onboarding"
            className="mt-8 inline-flex items-center gap-2 rounded-full bg-neutral-900 px-7 py-3.5 text-base font-semibold text-white transition hover:bg-neutral-800"
          >
            Get started
            <ArrowRightIcon className="size-4" />
          </Link>
        </div>
      </section>
    </div>
  );
}
