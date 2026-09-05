/**
 * Merchant onboarding.
 *
 * POST /api/merchants — a business connects itself. Credentials are encrypted
 * inside createMerchant before anything is written, and the response carries
 * no secret except the webhook secret, which is shown exactly once because the
 * merchant must paste it into their Razorpay dashboard.
 */
import { NextResponse } from "next/server";
import {
  createMerchant,
  toPublic,
  ValidationError,
  type OnboardingInput,
} from "@/lib/merchants";
import { PUBLIC_URL } from "@/lib/env";
import { normaliseWorkflows } from "@/lib/workflows";
import type { Channel } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CHANNELS: Channel[] = ["email", "whatsapp", "voice"];

function asChannels(v: unknown): Channel[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((c): c is Channel => CHANNELS.includes(c as Channel));
  return out.length > 0 ? out : undefined;
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Malformed JSON body." }, { status: 400 });
  }

  const input: OnboardingInput = {
    business_name: String(body.business_name ?? ""),
    razorpay_key_id: String(body.razorpay_key_id ?? ""),
    razorpay_key_secret: String(body.razorpay_key_secret ?? ""),
    whatsapp_number: body.whatsapp_number ? String(body.whatsapp_number) : null,
    voice_number: body.voice_number ? String(body.voice_number) : null,
    contact_window_start: body.contact_window_start
      ? String(body.contact_window_start)
      : undefined,
    contact_window_end: body.contact_window_end
      ? String(body.contact_window_end)
      : undefined,
    timezone: body.timezone ? String(body.timezone) : undefined,
    max_attempts:
      body.max_attempts !== undefined && body.max_attempts !== null
        ? Number(body.max_attempts)
        : undefined,
    channels_enabled: asChannels(body.channels_enabled),
    // Undefined rather than an empty array when nothing usable was sent, so
    // createMerchant falls back to all four rather than storing "none on".
    workflows_enabled:
      body.workflows_enabled === undefined
        ? undefined
        : normaliseWorkflows(body.workflows_enabled),
  };

  try {
    const { merchant, webhook_secret } = await createMerchant(input);
    const publicMerchant = toPublic(merchant, PUBLIC_URL());

    return NextResponse.json(
      {
        merchant: publicMerchant,
        // Shown once. Tally cannot display it again, by design.
        webhook_secret,
        next_steps: {
          webhook_url: publicMerchant.webhook_url,
          dashboard_url: publicMerchant.dashboard_url,
          events_to_subscribe: [
            "payment.failed",
            "payment.captured",
            "payment.authorized",
            "order.paid",
            "subscription.halted",
            "subscription.charged",
            "invoice.expired",
            "invoice.paid",
          ],
        },
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json(
        { error: err.message, field: err.field },
        { status: 422 },
      );
    }
    console.error("[onboarding] failed", err);
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Could not connect this business right now.",
      },
      { status: 500 },
    );
  }
}
