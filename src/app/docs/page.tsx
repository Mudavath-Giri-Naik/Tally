/**
 * Public setup documentation — the "how a new business connects" guide.
 * Phase 3's done-when is that someone can get from this page to their first
 * event on the dashboard without writing code or asking us anything.
 */
import Link from "next/link";

export const metadata = {
  title: "Setup guide — Tally",
  description: "Connect your Razorpay account to Tally in about two minutes.",
};

export default function DocsPage() {
  return (
    <div className="shell shell--narrow" style={{ paddingTop: 48 }}>
      <h1>Setup guide</h1>
      <p className="muted">
        Connecting takes about two minutes and needs no code. You will need
        access to your Razorpay dashboard.
      </p>

      <div className="callout" style={{ marginTop: 24 }}>
        Use your Razorpay <strong>test</strong> keys first. Tally behaves
        identically in test mode, so you can watch a real failure flow all the
        way through before pointing it at live traffic.
      </div>

      <section className="section">
        <h2>What you will need</h2>
        <ul className="muted">
          <li>Your Razorpay Key ID and Key Secret</li>
          <li>The hours you are happy for customers to be contacted</li>
          <li>
            Optionally, a phone number for WhatsApp and voice recovery
          </li>
        </ul>
      </section>

      <section className="section">
        <h2>Step by step</h2>
        <ol className="steps" style={{ marginTop: 20 }}>
          <li>
            <h3>Get your Razorpay API keys</h3>
            <p className="muted small">
              In Razorpay: <strong>Account &amp; Settings → API Keys →
              Generate Key</strong>. Razorpay shows the secret once, so copy it
              before closing the dialog.
            </p>
          </li>

          <li>
            <h3>Connect your business to Tally</h3>
            <p className="muted small">
              Fill in <Link href="/onboarding">the connect form</Link> with
              those keys, your contact window, and the channels you want to
              use. Your credentials are encrypted before they are stored.
            </p>
          </li>

          <li>
            <h3>Add the webhook to Razorpay</h3>
            <p className="muted small">
              Tally gives you a webhook URL unique to your business, and a
              signing secret. In Razorpay go to{" "}
              <strong>Settings → Webhooks → Add New Webhook</strong>, paste the
              URL into the URL field and the secret into the{" "}
              <em>Secret</em> field.
            </p>
            <p className="muted small">Subscribe to these events:</p>
            <pre>
              <code>
                {[
                  "payment.failed",
                  "order.paid",
                  "subscription.halted",
                  "subscription.charged",
                  "invoice.expired",
                ].join("\n")}
              </code>
            </pre>
            <p className="muted small">
              The <code>.paid</code> and <code>.charged</code> events are how
              Tally knows a recovery actually worked. Without them your recovery
              numbers will read as zero even when customers are paying.
            </p>
          </li>

          <li>
            <h3>Trigger a test failure</h3>
            <p className="muted small">
              In Razorpay test mode, start a payment and use a card that
              declines. Razorpay posts the failure to Tally, and the event
              appears on your dashboard within a minute — already classified
              with the reason it failed.
            </p>
          </li>

          <li>
            <h3>Watch</h3>
            <p className="muted small">
              That is the whole setup. The agent runs on its own from here. Your
              dashboard shows what it did, to whom, and why.
            </p>
          </li>
        </ol>
      </section>

      <section className="section">
        <h2>About the channels</h2>

        <h3 style={{ marginTop: 20 }}>Email</h3>
        <p className="muted small">
          Works immediately, no approval needed.
        </p>

        <h3 style={{ marginTop: 18 }}>WhatsApp</h3>
        <p className="muted small">
          During the MVP, WhatsApp goes through a shared Twilio Sandbox number.
          That has one real consequence: a customer can only receive a WhatsApp
          message if they have joined the sandbox by sending its join code
          first. It is fine for testing with people you know, and not suitable
          for real customers.
        </p>
        <div className="callout" style={{ marginTop: 10 }}>
          <strong>The production path.</strong> Connect your own WhatsApp
          Business sender through Twilio, and messages come from your number
          with no join step for the customer. Tally already sends per-merchant;
          only the sender identity changes. This is not built yet.
        </div>

        <h3 style={{ marginTop: 18 }}>Voice</h3>
        <p className="muted small">
          A real outbound call that reads a short scripted message in an Indian
          English/Hindi voice. Tally reserves calls for higher-value failures,
          where a call is proportionate.
        </p>
      </section>

      <section className="section">
        <h2>The rules Tally follows</h2>
        <p className="muted small">
          These are enforced in code, not left to the agent&apos;s judgement:
        </p>
        <ul className="muted small">
          <li>
            <strong>Contact window.</strong> Nobody is contacted outside the
            hours you set. A message that would land outside them waits.
          </li>
          <li>
            <strong>Attempt cap.</strong> Once an event hits your maximum, Tally
            stops, permanently.
          </li>
          <li>
            <strong>Opt-out is immediate.</strong> An opted-out customer is
            never contacted again, on any channel, for any event.
          </li>
          <li>
            <strong>No pointless retries.</strong> A payment method that cannot
            work is never retried — Tally asks for a different one instead.
          </li>
          <li>
            <strong>One message per person.</strong> Several open issues for the
            same customer are combined into a single message.
          </li>
          <li>
            <strong>Humans for hard cases.</strong> Risk-flagged payments and
            customers failing repeatedly across cycles are escalated, not
            automated at.
          </li>
        </ul>
      </section>

      <section className="section">
        <h2>Troubleshooting</h2>

        <h3 style={{ marginTop: 18 }}>No events appear on my dashboard</h3>
        <p className="muted small">
          Check the webhook in Razorpay is <em>Active</em>, and that the secret
          matches the one Tally gave you exactly — a mismatched secret makes
          Tally reject the delivery, which Razorpay shows as a failed webhook
          attempt. Also confirm <code>payment.failed</code> is subscribed.
        </p>

        <h3 style={{ marginTop: 18 }}>Events arrive but nothing is sent</h3>
        <p className="muted small">
          The most common causes are the contact window (Tally is waiting for
          it to open), a customer with no email or phone attached to the
          payment, or WhatsApp sandbox opt-in. The dashboard audit trail states
          which of these applied for each event.
        </p>

        <h3 style={{ marginTop: 18 }}>My recovery rate shows zero</h3>
        <p className="muted small">
          Subscribe to <code>order.paid</code> and{" "}
          <code>subscription.charged</code>. Tally only counts a recovery when
          the provider confirms the customer actually paid — not when a message
          was sent.
        </p>
      </section>

      <div className="card" style={{ marginTop: 40, textAlign: "center" }}>
        <h3>Ready?</h3>
        <p className="muted small" style={{ marginBottom: 16 }}>
          Connecting takes about two minutes.
        </p>
        <Link className="btn" href="/onboarding">
          Connect your business
        </Link>
      </div>
    </div>
  );
}
