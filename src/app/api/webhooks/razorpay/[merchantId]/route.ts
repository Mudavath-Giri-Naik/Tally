/**
 * The Razorpay webhook endpoint.
 *
 * One handler serves every merchant. The merchant id in the path selects whose
 * secret verifies the signature, and every write is scoped to that id.
 *
 * This route does as little as possible: verify, classify, write one row,
 * return 200. No sending, no model calls, no external requests. Razorpay
 * retries anything slow or failed, and a webhook that does real work turns a
 * bad afternoon into a retry storm. The background worker does the work.
 */
import { NextResponse } from "next/server";
import { getMerchant } from "@/lib/merchants";
import { verifyWebhookSignature } from "@/lib/crypto";
import {
  normalise,
  isSupportedEvent,
  RECOVERY_CONFIRMATION_EVENTS,
  type RazorpayWebhook,
} from "@/lib/razorpay";
import {
  ingestEvent,
  markRecoveredByReference,
  findCustomerByContact,
} from "@/lib/events";
import { normalisePhone } from "@/lib/razorpay";

export const runtime = "nodejs";
// Never cached, never statically analysed - this is a pure side-effect route.
export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  context: { params: Promise<{ merchantId: string }> },
): Promise<NextResponse> {
  const { merchantId } = await context.params;

  if (!UUID_RE.test(merchantId)) {
    return NextResponse.json({ error: "Unknown endpoint" }, { status: 404 });
  }

  // The signature is computed over the exact bytes Razorpay sent. Parsing to
  // JSON first and re-serialising changes them, and verification then fails
  // for reasons that look impossible to debug.
  const rawBody = await request.text();
  const signature = request.headers.get("x-razorpay-signature");

  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  }

  let merchant;
  try {
    merchant = await getMerchant(merchantId);
  } catch (err) {
    console.error("[webhook] merchant lookup failed", err);
    // 500 so Razorpay retries - the event is not lost to a transient DB blip.
    return NextResponse.json({ error: "Temporarily unavailable" }, { status: 500 });
  }

  // Same response for "no such merchant" and "bad signature": revealing which
  // merchant ids exist would let anyone enumerate Tally's customer list.
  if (!merchant || !verifyWebhookSignature(rawBody, signature, merchant.webhook_secret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  if (!merchant.active) {
    return NextResponse.json({ status: "merchant_paused" }, { status: 200 });
  }

  let hook: RazorpayWebhook;
  try {
    hook = JSON.parse(rawBody) as RazorpayWebhook;
  } catch {
    // Malformed body. 400, not 500 - retrying will not fix it.
    return NextResponse.json({ error: "Malformed JSON" }, { status: 400 });
  }

  if (!hook?.event || !isSupportedEvent(hook.event)) {
    // Acknowledge so Razorpay stops retrying an event we deliberately ignore.
    return NextResponse.json({ status: "ignored", event: hook?.event ?? null });
  }

  try {
    // A success confirmation closes an open recovery rather than opening one.
    if (RECOVERY_CONFIRMATION_EVENTS.has(hook.event)) {
      const entity =
        hook.payload?.payment?.entity ??
        hook.payload?.order?.entity ??
        hook.payload?.subscription?.entity ??
        hook.payload?.invoice?.entity ??
        {};
      const amount =
        typeof entity.amount === "number" ? (entity.amount as number) : null;
      // Resolved so a payment that cannot be matched by order id can still
      // be credited to that customer's open case - a retried checkout is a
      // new Razorpay order, so the reference never matches the case it paid.
      const customerId = await findCustomerByContact(merchant.id, {
        email: (entity.email ?? null) as string | null,
        phone: normalisePhone((entity.contact ?? null) as string | null),
      }).catch(() => null);

      const recovered = await markRecoveredByReference(
        merchant.id,
        {
          orderId: (entity.order_id ?? entity.id) as string | null,
          subscriptionId: (entity.subscription_id ?? null) as string | null,
          customerId,
        },
        amount,
      );
      return NextResponse.json({ status: "recovered", closed: recovered.length });
    }

    const normalised = normalise(hook);
    if (!normalised) {
      return NextResponse.json({ status: "ignored", event: hook.event });
    }

    // Razorpay's own event id is the idempotency key. If it is absent, fall
    // back to the entity id so a replay still collapses to one row.
    const providerEventId =
      request.headers.get("x-razorpay-event-id") ??
      (normalised.metadata.payment_id as string | null) ??
      null;

    const event = await ingestEvent({
      merchantId: merchant.id,
      providerEventId,
      type: normalised.type,
      reason: normalised.reason,
      amount: normalised.amount,
      currency: normalised.currency,
      dueDate: normalised.dueDate,
      customerName: normalised.customerName,
      customerEmail: normalised.customerEmail,
      customerPhone: normalised.customerPhone,
      metadata: normalised.metadata,
    });

    return NextResponse.json({
      status: "queued",
      event_id: event.id,
      type: event.type,
      reason: event.reason,
    });
  } catch (err) {
    console.error("[webhook] ingestion failed", {
      merchant: merchant.id,
      event: hook.event,
      err,
    });
    // 500 makes Razorpay redeliver. Ingestion is idempotent, so a redelivery
    // that partially succeeded the first time is safe.
    return NextResponse.json({ error: "Ingestion failed" }, { status: 500 });
  }
}

/** Razorpay pings the URL when the merchant saves it in their dashboard. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ merchantId: string }> },
): Promise<NextResponse> {
  const { merchantId } = await context.params;
  if (!UUID_RE.test(merchantId)) {
    return NextResponse.json({ error: "Unknown endpoint" }, { status: 404 });
  }
  return NextResponse.json({ status: "ok", listening: true });
}
