import Link from "next/link";
import {
  ShieldCheckIcon,
  ArrowRightIcon,
  StarIcon,
  LockIcon,
  ZapIcon,
  Sparkles,
  SparklesIcon,
  ArrowUpRightIcon,
  WorkflowIcon,
  BanknoteIcon,
  CreditCardIcon,
  ServerCogIcon,
  SmartphoneIcon,
  SendIcon,
  ClockIcon,
  GitMergeIcon,
  OctagonXIcon,
  EyeIcon,
  LockKeyholeIcon,
} from "lucide-react";

import { listMerchants } from "@/lib/merchants";
import { merchantStats } from "@/lib/insights";
import { formatINR } from "@/lib/types";
import { HowItWorksDiagram } from "@/components/marketing/how-it-works-diagram";

// Real merchant data, queried live - not something to prerender once and go
// stale.
export const dynamic = "force-dynamic";

const FAILURE_CARDS = [
  {
    t: "Insufficient funds",
    d: "The money will exist later. Tally waits for a likely salary-credit date instead of retrying tonight and failing again.",
    icon: BanknoteIcon,
    chip: "bg-amber-50 text-amber-600",
    bar: "from-amber-400 to-amber-500",
  },
  {
    t: "Expired or blocked card",
    d: "No retry can ever work. Tally stops retrying and asks for a different payment method instead.",
    icon: CreditCardIcon,
    chip: "bg-rose-50 text-rose-600",
    bar: "from-rose-400 to-rose-500",
  },
  {
    t: "Gateway timeout",
    d: "The rails broke, not the customer. Tally retries quietly and apologises — it never implies they were declined.",
    icon: ServerCogIcon,
    chip: "bg-sky-50 text-sky-600",
    bar: "from-sky-400 to-sky-500",
  },
  {
    t: "OTP not completed",
    d: "Just a slip on a busy day. A fresh link and one short nudge, with no explanation demanded.",
    icon: SmartphoneIcon,
    chip: "bg-emerald-50 text-emerald-600",
    bar: "from-emerald-400 to-emerald-500",
  },
];

const FEATURE_CARDS = [
  {
    t: "Acts, rather than labels",
    d: "It sends the message, places the call, and generates the retry link — inside the guardrails you set.",
    icon: SendIcon,
    chip: "bg-violet-50 text-violet-600",
    bar: "from-violet-400 to-violet-500",
  },
  {
    t: "Respects your rules",
    d: "A contact window, an attempt cap, and an instant stop on opt-out. A message that would land at 2am waits until morning.",
    icon: ClockIcon,
    chip: "bg-sky-50 text-sky-600",
    bar: "from-sky-400 to-sky-500",
  },
  {
    t: "One message, not three",
    d: "If a customer has a failed subscription and an abandoned cart, they hear from you once, about both.",
    icon: GitMergeIcon,
    chip: "bg-amber-50 text-amber-600",
    bar: "from-amber-400 to-amber-500",
  },
  {
    t: "Knows when to stop",
    d: "After a few failed cycles, or anything flagged by risk checks, it stops automating and hands over to a person.",
    icon: OctagonXIcon,
    chip: "bg-rose-50 text-rose-600",
    bar: "from-rose-400 to-rose-500",
  },
  {
    t: "Shows its reasoning",
    d: "Every action records why it was taken, which rule fired, and what was sent. Nothing happens off the record.",
    icon: EyeIcon,
    chip: "bg-indigo-50 text-indigo-600",
    bar: "from-indigo-400 to-indigo-500",
  },
  {
    t: "Your keys, your customers",
    d: "Your Razorpay credentials are encrypted per business and used only to act for you. Merchants are isolated from each other.",
    icon: LockKeyholeIcon,
    chip: "bg-emerald-50 text-emerald-600",
    bar: "from-emerald-400 to-emerald-500",
  },
];

/** Real merchants, with their real recovery figures - not sample data. */
async function connectedBusinesses() {
  let merchants;
  try {
    merchants = await listMerchants();
  } catch {
    // A DB hiccup on the marketing page must not take the whole page down;
    // the section just does not render.
    return [];
  }

  return Promise.all(
    merchants.map(async (m) => {
      const stats = await merchantStats(m.id, 90).catch(() => null);
      return {
        slug: m.slug,
        name: m.business_name,
        active: m.active,
        recovered: stats?.amount_recovered ?? 0,
        recoveryRate: stats?.recovery_rate ?? 0,
        events: stats?.total_events ?? 0,
      };
    }),
  );
}

export default async function HomePage() {
  const businesses = await connectedBusinesses();

  return (
    <div className="bg-white">
      {/* ── hero: sky, navbar, headline, hills+dashboard reveal ── */}
      <div className="relative overflow-hidden bg-white">
        {/* Background Image Layer.

            This box's aspect-ratio is the image's own real pixel dimensions
            (1713x918), not the section's height - that is what makes the fade
            below actually land on the image's true bottom edge instead of
            somewhere in the empty space beneath it. With the box's ratio
            matching the image exactly, bg-size 100% 100% fills it perfectly
            with zero distortion and zero cropping - there is no mismatch
            between the two shapes for either of those to correct. */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 aspect-[1713/918] w-full bg-[url('/background.png')] bg-top bg-no-repeat [background-size:100%_100%]"
          aria-hidden="true"
        >
          {/* Fades the image's own bottom edge into the white section below,
              anchored to this box - which now ends exactly where the image
              itself ends - so the seam actually disappears. */}
          <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-white to-transparent sm:h-32" />
        </div>

        <div className="relative">
          {/* ── navbar ── */}
          <header className="mx-auto flex w-full max-w-[820px] items-center justify-center gap-3 px-4 pt-5 sm:px-6">
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

            {/* Deliberately outside the navbar pill, its own separate
                rounded box sitting parallel to it - not another item inside
                the same bar as the nav links and CTA. */}
            <a
              href="https://github.com/Mudavath-Giri-Naik/Tally"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="View the source on GitHub"
              className="flex size-11 shrink-0 items-center justify-center rounded-2xl border-[3px] border-white/50 bg-white shadow-sm backdrop-blur transition hover:bg-neutral-50"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/icons/github.png" alt="" className="size-5" />
            </a>
          </header>

          {/* ── headline ── */}
          <div className="mx-auto max-w-4xl px-4 pt-10 pb-6 text-center sm:px-6 sm:pt-14 sm:pb-8">
            <h1 className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-3xl leading-[1.05] font-extrabold tracking-tight text-neutral-900 sm:text-5xl md:text-6xl">
              Revenue
              <span className="relative inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-b from-slate-600 to-slate-800 align-middle shadow-xl shadow-slate-900/30 sm:size-11 md:size-12 -rotate-6 border-t border-slate-500">
                <span className="absolute top-1 left-2"><Sparkles className="size-2 sm:size-3 text-white/80" fill="currentColor" /></span>
                <span className="text-lg sm:text-xl md:text-2xl font-bold text-slate-200 tracking-tighter">AI</span>
              </span>
              Recovery
            </h1>
            <p className="mx-auto mt-4 max-w-lg text-sm text-neutral-600 sm:text-base">
              AI that finds out why a payment failed — and gets it back for you, automatically.
            </p>

            <div className="mt-5 flex flex-col items-center justify-center gap-2.5 sm:flex-row">
              <div className="rounded-full bg-[#4A85F6]/20 p-1">
                <Link
                  href="/onboarding"
                  className="flex w-full items-center justify-center gap-2 rounded-full bg-[#4A85F6] px-5 py-2 text-sm font-semibold text-white shadow-md transition hover:bg-[#366AE6] sm:w-auto border border-[#76A1F9]"
                >
                  Connect your business
                  <span className="flex size-5 items-center justify-center rounded-full bg-white text-[#4A85F6]">
                    <ArrowRightIcon className="size-3" strokeWidth={3} />
                  </span>
                </Link>
              </div>
              <Link
                href="/dashboard/mandate-2"
                className="w-full rounded-full border border-transparent bg-white px-6 py-2.5 text-center text-sm font-semibold text-neutral-900 shadow-sm transition hover:bg-neutral-50 sm:w-auto"
              >
                View demo
              </Link>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-xs text-neutral-600 font-medium">
              <span className="flex items-center gap-1.5">
                <StarIcon className="size-3.5 text-amber-500" fill="currentColor" />
                Guardrail-checked every send
              </span>
              <span className="hidden text-neutral-300 sm:inline">|</span>
              <span className="flex items-center gap-1.5">
                <LockIcon className="size-3.5 text-emerald-500" />
                AES-256 encrypted keys
              </span>
              <span className="hidden text-neutral-300 sm:inline">|</span>
              <span className="flex items-center gap-1.5">
                <ZapIcon className="size-3.5 text-red-500" fill="currentColor" />
                Live within five minutes
              </span>
            </div>
          </div>

          {/* ── dashboard: a plain static image, no scroll animation ── */}
          <div className="mx-auto max-w-5xl px-4 pb-14 sm:px-6 sm:pb-20">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/dashboard.png"
              alt="Tally's live recovery dashboard"
              className="w-full rounded-xl border-[8px] border-white/80 shadow-2xl sm:rounded-2xl sm:border-[12px]"
            />
          </div>
        </div>
      </div>

      {/* ── how it works: the pipeline itself, drawn and moving ──
          Everything in FAILURE_CARDS was already true and already good copy -
          it just used to be the whole section. It is the supporting evidence
          now, under a diagram of the actual system a visitor is about to
          connect their Razorpay account to. */}
      <section id="how-it-works" className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
        <div className="mx-auto max-w-2xl text-center">
          <span className="animate-fade-up marketing-motion inline-flex items-center gap-1.5 rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs font-bold tracking-wide text-indigo-600 uppercase">
            <WorkflowIcon className="size-3.5" />
            How it works
          </span>
          <h2 className="animate-fade-up marketing-motion mt-4 text-3xl font-bold tracking-tight text-neutral-900 sm:text-4xl" style={{ animationDelay: "80ms" }}>
            One pipeline, from webhook to paid
          </h2>
          <p className="animate-fade-up marketing-motion mt-4 text-neutral-600" style={{ animationDelay: "160ms" }}>
            The model only ever writes the words. Every stop, every channel,
            and every guardrail below it is deterministic code - traced
            straight from Tally&rsquo;s own worker, not a simplified stand-in
            for it.
          </p>
        </div>

        <div className="animate-fade-up marketing-motion mt-14 rounded-[2rem] border border-neutral-200 bg-gradient-to-b from-white to-neutral-50/60 p-4 shadow-sm sm:p-8" style={{ animationDelay: "240ms" }}>
          <HowItWorksDiagram />
        </div>

        <div className="mx-auto mt-6 max-w-2xl text-center">
          <p className="text-sm text-neutral-500">
            Why the <em>reason</em> a payment failed is the whole product:
          </p>
        </div>

        <div className="mt-8 grid gap-5 sm:grid-cols-2">
          {FAILURE_CARDS.map((c, i) => (
            <div
              key={c.t}
              className="animate-fade-up marketing-motion group relative overflow-hidden rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg"
              style={{ animationDelay: `${320 + i * 90}ms` }}
            >
              <span
                className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${c.bar} opacity-0 transition-opacity group-hover:opacity-100`}
                aria-hidden="true"
              />
              <span className={`flex size-10 items-center justify-center rounded-xl ${c.chip}`}>
                <c.icon className="size-5" />
              </span>
              <h3 className="mt-4 font-semibold text-neutral-900">{c.t}</h3>
              <p className="mt-2 text-sm text-neutral-600">{c.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── what it does on its own ── */}
      <section id="features" className="relative overflow-hidden bg-neutral-50 py-20 sm:py-28">
        {/* A quiet gradient wash rather than a flat fill, so the section
            reads as a distinct plane without a hard seam against the white
            sections either side of it. */}
        <div
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_60%_at_50%_0%,rgba(74,133,246,0.08),transparent)]"
          aria-hidden="true"
        />
        <div className="relative mx-auto max-w-6xl px-4 sm:px-6">
          <div className="mx-auto max-w-2xl text-center">
            <span className="animate-fade-up marketing-motion inline-flex items-center gap-1.5 rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-xs font-bold tracking-wide text-violet-600 uppercase">
              <SparklesIcon className="size-3.5" />
              Features
            </span>
            <h2 className="animate-fade-up marketing-motion mt-4 text-3xl font-bold tracking-tight text-neutral-900 sm:text-4xl" style={{ animationDelay: "80ms" }}>
              What it does on its own
            </h2>
          </div>

          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURE_CARDS.map((c, i) => (
              <div
                key={c.t}
                className="animate-fade-up marketing-motion group relative overflow-hidden rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm transition hover:-translate-y-1 hover:shadow-xl"
                style={{ animationDelay: `${i * 90}ms` }}
              >
                <span
                  className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${c.bar}`}
                  aria-hidden="true"
                />
                <span className={`flex size-11 items-center justify-center rounded-xl transition-transform duration-300 group-hover:scale-110 ${c.chip}`}>
                  <c.icon className="size-5" />
                </span>
                <h3 className="mt-4 font-semibold text-neutral-900">{c.t}</h3>
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

      {/* ── connected businesses (clients) ──
          Real merchant rows, not logos - a placeholder client-logo strip
          would be the one dishonest thing on this page, on a site whose
          entire pitch is that its numbers can be trusted. Every figure here
          comes from merchantStats() at request time. */}
      {businesses.length > 0 && (
        <section className="relative mx-auto max-w-6xl px-4 pb-20 sm:px-6 sm:pb-28">
          <div className="mx-auto max-w-2xl text-center">
            <span className="animate-fade-up marketing-motion inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-bold tracking-wide text-emerald-600 uppercase">
              <StarIcon className="size-3.5" fill="currentColor" />
              Clients
            </span>
            <h2 className="animate-fade-up marketing-motion mt-4 text-3xl font-bold tracking-tight text-neutral-900 sm:text-4xl" style={{ animationDelay: "80ms" }}>
              Businesses already connected
            </h2>
            <p className="animate-fade-up marketing-motion mt-4 text-neutral-600" style={{ animationDelay: "160ms" }}>
              Real merchants, real recovery figures - click through to see any
              of these dashboards live.
            </p>
          </div>

          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {businesses.map((b, i) => (
              <Link
                key={b.slug}
                href={`/dashboard/${b.slug}`}
                className="animate-fade-up marketing-motion group relative flex flex-col justify-between overflow-hidden rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm transition hover:-translate-y-1 hover:border-neutral-300 hover:shadow-xl"
                style={{ animationDelay: `${i * 90}ms` }}
              >
                {/* A live business gets a moving pulse on its accent bar - a
                    paused one gets the same bar, held still. The colour is
                    already saying "active"; the motion is what makes that
                    claim feel like it is happening right now. */}
                <span
                  className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${
                    b.active ? "from-emerald-400 via-emerald-500 to-teal-400" : "from-neutral-200 to-neutral-300"
                  }`}
                  aria-hidden="true"
                />

                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span
                      className={`flex size-10 shrink-0 items-center justify-center rounded-xl text-sm font-bold text-white shadow-sm ${
                        b.active
                          ? "bg-gradient-to-br from-emerald-400 to-teal-600"
                          : "bg-gradient-to-br from-neutral-300 to-neutral-400"
                      }`}
                    >
                      {b.name.slice(0, 1).toUpperCase()}
                    </span>
                    <div>
                      <div className="font-semibold text-neutral-900">{b.name}</div>
                      <span
                        className={`mt-0.5 inline-flex items-center gap-1.5 text-xs font-medium ${
                          b.active ? "text-emerald-600" : "text-neutral-400"
                        }`}
                      >
                        <span
                          className={`size-1.5 rounded-full ${
                            b.active ? "bg-emerald-500 animate-pulse" : "bg-neutral-300"
                          }`}
                        />
                        {b.active ? "Live" : "Paused"}
                      </span>
                    </div>
                  </div>
                  <ArrowUpRightIcon className="size-4 shrink-0 text-neutral-300 transition group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-neutral-600" />
                </div>

                <div className="mt-6 grid grid-cols-2 gap-4">
                  <div>
                    <div className="text-lg font-bold tracking-tight text-neutral-900">
                      {formatINR(b.recovered)}
                    </div>
                    <div className="text-xs text-neutral-500">recovered</div>
                  </div>
                  <div>
                    <div className="text-lg font-bold tracking-tight text-neutral-900">
                      {b.recoveryRate}%
                    </div>
                    <div className="text-xs text-neutral-500">recovery rate</div>
                  </div>
                </div>

                {/* The recovery rate, drawn as well as stated - the same
                    number as above, never a second calculation of it. */}
                <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-neutral-100">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-teal-500 transition-[width] duration-700"
                    style={{ width: `${Math.min(100, Math.max(0, b.recoveryRate))}%` }}
                  />
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
