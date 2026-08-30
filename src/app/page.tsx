import Link from "next/link";
import {
  ShieldCheckIcon,
  ArrowRightIcon,
  StarIcon,
  LockIcon,
  ZapIcon,
  Sparkles,
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
      <div className="relative overflow-hidden bg-white">
        {/* Background Image Layer - bg-cover so it always fully fills the
            section with no gap of plain white beneath it, however tall the
            section ends up being. Cover scales proportionally rather than
            stretching each axis independently, so nothing distorts - it
            crops rather than warps. Full opacity throughout, no fade mask. */}
        <div
          className="pointer-events-none absolute inset-0 bg-[url('/background.png')] bg-top bg-no-repeat"
          aria-hidden="true"
        />

        <div className="relative">
          {/* ── navbar ── */}
          <header className="mx-auto flex justify-center px-4 pt-5 sm:px-6">
            <div className="flex w-full max-w-[760px] items-center justify-between gap-6 rounded-2xl border-[3px] border-white/50 bg-white px-2.5 py-2.5 shadow-sm backdrop-blur sm:px-3">
              <Link href="/" className="flex shrink-0 items-center gap-2">
                <span className="flex size-7 items-center justify-center rounded-[0.35rem] bg-[#1a1a1a] text-white">
                  <ShieldCheckIcon className="size-3.5" strokeWidth={2.5} />
                </span>
                <span className="text-base font-bold tracking-tight text-neutral-900">
                  Tally
                </span>
              </Link>

              <nav className="hidden items-center gap-6 text-sm font-semibold text-neutral-600 md:flex">
                <a href="#how-it-works" className="transition-colors hover:text-neutral-900">
                  How it works
                </a>
                <a href="#features" className="transition-colors hover:text-neutral-900">
                  Features
                </a>
                <Link href="/docs" className="transition-colors hover:text-neutral-900">
                  Docs
                </Link>
              </nav>

              <Link
                href="/onboarding"
                className="flex shrink-0 items-center gap-2 rounded-full bg-gradient-to-b from-[#3a3a3a] to-[#121212] py-2 pl-3.5 pr-1 text-sm font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] border border-[#222] transition hover:from-[#4a4a4a] hover:to-[#222]"
              >
                <span className="inline">Connect now</span>
                <span className="flex size-5 items-center justify-center rounded-full bg-white text-neutral-900">
                  <ArrowRightIcon className="size-3" strokeWidth={2.5} />
                </span>
              </Link>
            </div>
          </header>

          {/* ── headline ── */}
          {/* Bottom padding has to clear the space the dashboard's raised
              resting position (top:-26% in HeroReveal) reaches up into - that
              offset is a percentage of a box whose height scales with viewport
              width, so wider screens need more clearance here, not less. */}
          <div className="mx-auto max-w-5xl px-4 pb-32 pt-16 text-center sm:px-6 sm:pt-24 sm:pb-80">
            <h1 className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-[2.6rem] leading-[1.05] font-extrabold tracking-tight text-neutral-900 sm:text-6xl md:text-7xl lg:text-[5.5rem]">
              Revenue
              <span className="relative inline-flex size-14 shrink-0 items-center justify-center rounded-[1.5rem] bg-gradient-to-b from-slate-600 to-slate-800 align-middle shadow-2xl shadow-slate-900/30 sm:size-16 md:size-[4.5rem] lg:size-[5rem] -rotate-6 border-t border-slate-500">
                <span className="absolute top-2 left-3"><Sparkles className="size-3 sm:size-4 md:size-5 text-white/80" fill="currentColor" /></span>
                <span className="text-3xl sm:text-4xl md:text-5xl font-bold text-slate-200 tracking-tighter">AI</span>
              </span>
              Recovery
            </h1>
            <p className="mx-auto mt-6 max-w-xl text-base text-neutral-600 sm:text-lg">
              AI that finds out why a payment failed — and gets it back for you, automatically.
            </p>

            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <div className="rounded-full bg-[#4A85F6]/20 p-1">
                <Link
                  href="/onboarding"
                  className="flex w-full items-center justify-center gap-2 rounded-full bg-[#4A85F6] px-6 py-3 text-base font-semibold text-white shadow-md transition hover:bg-[#366AE6] sm:w-auto border border-[#76A1F9]"
                >
                  Connect your business
                  <span className="flex size-6 items-center justify-center rounded-full bg-white text-[#4A85F6]">
                    <ArrowRightIcon className="size-3.5" strokeWidth={3} />
                  </span>
                </Link>
              </div>
              <Link
                href="/dashboard/mandate-2"
                className="w-full rounded-full border border-transparent bg-white px-8 py-4 text-center text-base font-semibold text-neutral-900 shadow-sm transition hover:bg-neutral-50 sm:w-auto"
              >
                View demo
              </Link>
            </div>

            <div className="mt-5 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-neutral-600 font-medium">
              <span className="flex items-center gap-1.5">
                <StarIcon className="size-4 text-amber-500" fill="currentColor" />
                Guardrail-checked every send
              </span>
              <span className="hidden text-neutral-300 sm:inline">|</span>
              <span className="flex items-center gap-1.5">
                <LockIcon className="size-4 text-emerald-500" />
                AES-256 encrypted keys
              </span>
              <span className="hidden text-neutral-300 sm:inline">|</span>
              <span className="flex items-center gap-1.5">
                <ZapIcon className="size-4 text-red-500" fill="currentColor" />
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
