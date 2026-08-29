/**
 * Settings: contact rules, connection details, and the integration checklist.
 *
 * The credentials shown here are masked by `toPublic` before they leave the
 * server - this page never receives a plaintext key, by construction rather
 * than by remembering not to render one.
 */
import { notFound } from "next/navigation";
import { resolveMerchant, toPublic } from "@/lib/merchants";
import { PUBLIC_URL } from "@/lib/env";
import { PageHead, Panel } from "@/components/ui";
import { SettingsForm } from "@/components/settings-form";
import { CopyField } from "@/components/copy-field";

export const dynamic = "force-dynamic";

const RAZORPAY_EVENTS = [
  "payment.failed",
  "order.paid",
  "subscription.halted",
  "subscription.charged",
  "invoice.expired",
];

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const merchant = await resolveMerchant(slug).catch(() => null);
  if (!merchant) notFound();

  const pub = toPublic(merchant, PUBLIC_URL());

  return (
    <>
      <PageHead
        title="Settings"
        lede={`How Tally acts on behalf of ${merchant.business_name}.`}
      />

      <SettingsForm
        merchantId={merchant.id}
        initial={{
          contact_window_start: merchant.contact_window_start,
          contact_window_end: merchant.contact_window_end,
          timezone: merchant.timezone,
          max_attempts: merchant.max_attempts,
          channels_enabled: merchant.channels_enabled,
          active: merchant.active,
        }}
      />

      <Panel
        title="Razorpay connection"
        hint="This URL is unique to your business. Razorpay posts every subscribed event to it."
      >
        <CopyField label="Webhook URL" value={pub.webhook_url} />

        <div className="kv">
          <div>
            <dt>Key ID</dt>
            <dd>
              <code>{pub.razorpay_key_id_masked}</code>
            </dd>
          </div>
          <div>
            <dt>Signing secret</dt>
            <dd className="muted small">
              Shown once at onboarding and never again. Reconnect the business
              to issue a new one.
            </dd>
          </div>
        </div>

        <div className="checklist">
          <div className="checklist__title">
            Events to subscribe in Razorpay
          </div>
          <p className="muted small">
            Recovery numbers stay at zero without <code>order.paid</code> and{" "}
            <code>subscription.charged</code> — Tally only counts a recovery
            when Razorpay confirms the payment, never when a message was sent.
          </p>
          <ul>
            {RAZORPAY_EVENTS.map((e) => (
              <li key={e}>
                <code>{e}</code>
              </li>
            ))}
          </ul>
        </div>
      </Panel>

      <Panel
        title="Dashboard address"
        hint="Bookmark this. It is the same link for everyone at your business."
      >
        <CopyField value={pub.dashboard_url} />
        <p className="muted small" style={{ marginBottom: 0 }}>
          Connected {new Date(merchant.created_at).toLocaleDateString("en-IN", {
            day: "numeric",
            month: "long",
            year: "numeric",
          })}
          . Internal id <code>{merchant.id}</code>, which older links may still
          use.
        </p>
      </Panel>
    </>
  );
}
