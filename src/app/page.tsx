import Link from "next/link";

export default function HomePage() {
  return (
    <div className="shell" style={{ paddingTop: 72 }}>
      <div style={{ maxWidth: 660 }}>
        <span className="pill pill--accent">Revenue recovery, on autopilot</span>
        <h1 style={{ fontSize: "2.7rem", marginTop: 18 }}>
          Failed payments are not lost payments.
        </h1>
        <p
          className="muted"
          style={{ fontSize: "1.1rem", marginTop: 16, lineHeight: 1.65 }}
        >
          Tally watches your Razorpay account, works out <em>why</em> each
          payment actually failed, and recovers it — by email, WhatsApp, or a
          real phone call. You connect it once and then just watch the number.
        </p>
        <div style={{ display: "flex", gap: 12, marginTop: 30, flexWrap: "wrap" }}>
          <Link className="btn" href="/onboarding">
            Connect your business
          </Link>
          <Link className="btn btn--ghost" href="/docs">
            Read the setup guide
          </Link>
        </div>
      </div>

      <section className="section" style={{ marginTop: 72 }}>
        <div className="section__head">
          <h2>The reason it failed is the whole product</h2>
        </div>
        <p className="muted" style={{ maxWidth: 660, marginTop: -4 }}>
          Most dunning tools retry everything on the same schedule. That wastes
          gateway fees on payments that can never succeed, and annoys customers
          who did nothing wrong. Tally treats each cause differently.
        </p>

        <div className="grid grid--2" style={{ marginTop: 22 }}>
          {[
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
          ].map((c) => (
            <div className="card" key={c.t}>
              <h3>{c.t}</h3>
              <p className="muted small" style={{ marginBottom: 0 }}>
                {c.d}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="section" style={{ marginTop: 64 }}>
        <div className="section__head">
          <h2>What it does on its own</h2>
        </div>
        <div className="grid grid--2">
          {[
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
          ].map((c) => (
            <div className="card" key={c.t}>
              <h3>{c.t}</h3>
              <p className="muted small" style={{ marginBottom: 0 }}>
                {c.d}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="section" style={{ marginTop: 64 }}>
        <div className="card" style={{ textAlign: "center", padding: 40 }}>
          <h2>Connect once. Then just watch.</h2>
          <p className="muted" style={{ maxWidth: 480, margin: "10px auto 22px" }}>
            Setup is a Razorpay key, a webhook URL, and the hours you are happy
            for customers to be contacted.
          </p>
          <Link className="btn" href="/onboarding">
            Get started
          </Link>
        </div>
      </section>
    </div>
  );
}
