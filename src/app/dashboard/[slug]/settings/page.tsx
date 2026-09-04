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
import { SettingsForm } from "@/components/settings-form";
import { CopyField } from "@/components/copy-field";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

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
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          How Tally acts on behalf of {merchant.business_name}.
        </p>
      </div>

      <SettingsForm
        merchantId={merchant.id}
        initial={{
          contact_window_start: merchant.contact_window_start,
          contact_window_end: merchant.contact_window_end,
          timezone: merchant.timezone,
          max_attempts: merchant.max_attempts,
          holdout_percent: merchant.holdout_percent ?? 0,
          channels_enabled: merchant.channels_enabled,
          ai_provider: merchant.ai_provider ?? null,
          ai_model: merchant.ai_model ?? null,
          active: merchant.active,
        }}
      />

      <Card>
        <CardHeader>
          <CardTitle>Razorpay connection</CardTitle>
          <p className="text-muted-foreground text-sm">
            This URL is unique to your business. Razorpay posts every subscribed
            event to it.
          </p>
        </CardHeader>
        <CardContent className="space-y-6">
          <CopyField label="Webhook URL" value={pub.webhook_url} />

          <div className="grid gap-6 sm:grid-cols-2">
            <div>
              <div className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
                Key ID
              </div>
              <code className="mt-1.5 block font-mono text-sm">
                {pub.razorpay_key_id_masked}
              </code>
            </div>
            <div>
              <div className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
                Signing secret
              </div>
              <p className="text-muted-foreground mt-1.5 text-sm">
                Shown once at onboarding and never again. Reconnect the business
                to issue a new one.
              </p>
            </div>
          </div>

          <Separator />

          <div>
            <div className="font-semibold">Events to subscribe in Razorpay</div>
            <p className="text-muted-foreground mt-1 text-sm">
              Recovery numbers stay at zero without <code>order.paid</code> and{" "}
              <code>subscription.charged</code> — Tally only counts a recovery
              when Razorpay confirms the payment, never when a message was sent.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {RAZORPAY_EVENTS.map((e) => (
                <Badge key={e} variant="secondary" className="font-mono">
                  {e}
                </Badge>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Dashboard address</CardTitle>
          <p className="text-muted-foreground text-sm">
            Bookmark this. It is the same link for everyone at your business.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <CopyField value={pub.dashboard_url} />
          <p className="text-muted-foreground text-sm">
            Connected{" "}
            {new Date(merchant.created_at).toLocaleDateString("en-IN", {
              day: "numeric",
              month: "long",
              year: "numeric",
            })}
            . Internal id <code className="font-mono">{merchant.id}</code>, which
            older links may still use.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
