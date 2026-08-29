/**
 * Inbound WhatsApp replies.
 *
 * The other half of the conversation. Everything else in Tally pushes messages
 * out; this is what happens when a customer answers.
 *
 * Two answers are acted on deterministically, because a model should not be
 * the thing standing between a customer and being left alone:
 *
 *   "STOP"              -> opt out immediately, stop every open event
 *   "I'll pay Friday"   -> a tracked promise-to-pay with a real due date
 *
 * Everything else is answered conversationally by the agent, with this
 * customer's real payment history in front of it (see agent/converse.ts).
 *
 * The shape of this route matters. Twilio wants a response in seconds and
 * shows the customer an error page if it does not get one, so the reply is
 * drafted and sent in `after()` - the webhook returns empty TwiML immediately
 * and the model call happens once Twilio has already been answered.
 */
import { NextResponse, after } from "next/server";
import twilio from "twilio";
import { optionalEnv, isConfigured, PUBLIC_URL } from "@/lib/env";
import { classifyReply, stripChannelPrefix } from "@/lib/inbound";
import { normalisePhone } from "@/lib/razorpay";
import {
  findCustomersByPhone,
  optOutCustomer,
  latestEventForCustomer,
  ingestEvent,
  recordAction,
} from "@/lib/events";
import { listMerchants, whatsappNumber, getMerchant } from "@/lib/merchants";
import { sendWhatsApp } from "@/lib/channels";
import {
  draftReply,
  conversationTurns,
  REPLY_PREFIX,
  type ConversationContext,
} from "@/lib/agent/converse";
import { db } from "@/lib/supabase";
import type { Customer, Merchant, RecoveryEvent } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Twilio is answered in milliseconds, but the reply drafted in `after()` keeps
// the function alive, and a Gemini call has been measured at ~24s. On the
// default limit that work is killed halfway through and the customer is simply
// never answered - with nothing in the logs to say why, because the request
// itself already returned 200. 60 is the Hobby ceiling.
export const maxDuration = 60;

/** Twilio treats any 2xx with empty TwiML as "handled, send nothing back". */
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

function twiml(status = 200): NextResponse {
  return new NextResponse(EMPTY_TWIML, {
    status,
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

/**
 * The URL Twilio signed.
 *
 * The signature covers the exact URL configured in the Twilio console, so that
 * is what we validate against first. Behind a proxy `request.url` is often the
 * internal address and would not match, so the forwarded headers are tried as
 * a fallback - a valid signature is still required either way.
 */
function candidateUrls(request: Request): string[] {
  const path = "/api/webhooks/whatsapp";
  // PUBLIC_URL normalises the trailing slash itself, so this is just a join.
  const urls = [`${PUBLIC_URL()}${path}`];

  const proto = request.headers.get("x-forwarded-proto");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (host) urls.push(`${proto ?? "https"}://${host}${path}`);
  urls.push(request.url.split("?")[0]);

  return [...new Set(urls)];
}

function signatureValid(
  request: Request,
  params: Record<string, string>,
  signature: string,
  authToken: string,
): boolean {
  return candidateUrls(request).some((url) => {
    try {
      return twilio.validateRequest(authToken, signature, url, params);
    } catch {
      return false;
    }
  });
}

/**
 * Which merchant is this reply for?
 *
 * In production each merchant connects its own WhatsApp sender, so the `To`
 * number identifies them exactly. On the shared Twilio Sandbox every merchant
 * sends from the same number, so `To` identifies nobody and this returns null -
 * the caller then works across every customer record matching the sender.
 */
async function merchantForRecipient(to: string): Promise<Merchant | null> {
  const wanted = normalisePhone(stripChannelPrefix(to));
  if (!wanted) return null;

  const sandbox = normalisePhone(
    stripChannelPrefix(optionalEnv("TWILIO_WHATSAPP_NUMBER") ?? ""),
  );
  if (sandbox && wanted === sandbox) return null; // shared sandbox: ambiguous

  for (const merchant of await listMerchants()) {
    try {
      if (normalisePhone(whatsappNumber(merchant) ?? "") === wanted) return merchant;
    } catch {
      // Undecryptable number (rotated key) - skip rather than fail the webhook.
    }
  }
  return null;
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!isConfigured("TWILIO_AUTH_TOKEN")) {
    console.error("[whatsapp-in] TWILIO_AUTH_TOKEN is not set - cannot verify signature");
    return twiml(500);
  }

  // Twilio posts form-encoded. The signature is computed over these fields, so
  // they must be read exactly as sent.
  const raw = await request.text();
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw)) params[k] = v;

  const signature = request.headers.get("x-twilio-signature");
  if (
    !signature ||
    !signatureValid(request, params, signature, optionalEnv("TWILIO_AUTH_TOKEN")!)
  ) {
    // Anyone can POST here; without this, a stranger could opt out a customer
    // or fabricate a promise-to-pay.
    return new NextResponse("Invalid signature", { status: 403 });
  }

  const from = params.From ?? "";
  const body = params.Body ?? "";
  const phone = normalisePhone(stripChannelPrefix(from));

  if (!phone) {
    console.warn("[whatsapp-in] unparseable sender", { from });
    return twiml();
  }

  try {
    const merchant = await merchantForRecipient(params.To ?? "");
    const customers = await findCustomersByPhone(phone, merchant?.id);

    if (customers.length === 0) {
      // Someone we have no record of. Nothing to attach it to; not an error.
      console.info("[whatsapp-in] reply from unknown number", {
        phone: phone.slice(0, 5) + "***",
      });
      return twiml();
    }

    const timeZone = merchant?.timezone ?? "Asia/Kolkata";
    const intent = classifyReply(body, new Date(), timeZone);

    for (const customer of customers) {
      await handle(customer, intent, body, params);
    }

    // Answer them. Deliberately not awaited inside the request: drafting a
    // reply costs a model call, and Twilio would time out and show the
    // customer an error long before it returned.
    //
    // An opt-out is never answered. Confirming a STOP is still a message to
    // someone who just asked for no more messages.
    if (intent.kind !== "opt_out") {
      after(async () => {
        for (const customer of customers) {
          await replyToCustomer(customer).catch((err) => {
            // The inbound message is already recorded either way, so a failed
            // reply degrades to "a human answers this one".
            console.error("[whatsapp-in] reply failed", {
              customer: customer.id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      });
    }

    return twiml();
  } catch (err) {
    console.error("[whatsapp-in] failed to process reply", err);
    // 200 regardless: Twilio retries on failure, and a retry would re-apply
    // the same opt-out or create a duplicate promise. The message is logged.
    return twiml();
  }
}

async function handle(
  customer: Customer,
  intent: ReturnType<typeof classifyReply>,
  body: string,
  params: Record<string, string>,
): Promise<void> {
  const messageSid = params.MessageSid ?? params.SmsMessageSid ?? null;

  /** Record the inbound message against an event, so the trail has both directions. */
  const log = async (
    eventId: string,
    outcome: "delivered" | "escalated" | "no_action",
    rationale: string,
    guardrail?: string,
  ) => {
    await recordAction({
      eventId,
      merchantId: customer.merchant_id,
      channel: "whatsapp",
      // Prefixed so an inbound line is never mistaken for something Tally said.
      message: `[inbound] ${body}`,
      outcome,
      response: messageSid,
      sentAt: new Date().toISOString(),
      decision: {
        root_cause: "unknown",
        intervention: intent.kind === "opt_out" ? "stop" : "escalate_human",
        channel: "whatsapp",
        rationale,
        source: "guardrail",
        guardrail,
      },
    });
  };

  if (intent.kind === "opt_out") {
    const stopped = await optOutCustomer(customer.id);
    const latest = await latestEventForCustomer(customer.id);
    if (latest) {
      await log(
        latest.id,
        "no_action",
        `Customer replied "${intent.matched}". Opted out and stopped ${stopped} open event(s). ` +
          `They will not be contacted again on any channel.`,
        "customer_opted_out",
      );
    }
    console.info("[whatsapp-in] opt-out honoured", {
      customer: customer.id,
      stopped,
    });
    return;
  }

  if (intent.kind === "promise_to_pay") {
    const latest = await latestEventForCustomer(customer.id);
    // The commitment becomes its own tracked event, due on the day they named.
    // The worker will pick it up then - not before.
    const promise = await ingestEvent({
      merchantId: customer.merchant_id,
      // Ties the promise to the Twilio message, so a redelivered webhook
      // updates nothing rather than booking the same promise twice.
      providerEventId: messageSid ? `wa_promise_${messageSid}` : null,
      type: "promise_to_pay",
      reason: "invoice_unpaid",
      amount: latest?.amount ?? null,
      dueDate: intent.dueDate,
      customerName: customer.name,
      customerEmail: customer.email,
      customerPhone: customer.phone,
      metadata: {
        source: "whatsapp_reply",
        promised_on: new Date().toISOString().slice(0, 10),
        due_date: intent.dueDate,
        reply_text: body.slice(0, 500),
        origin_event_id: latest?.id ?? null,
      },
    });

    // Do not chase before the day they promised.
    const { updateEvent } = await import("@/lib/events");
    await updateEvent(promise.id, {
      next_attempt_at: new Date(`${intent.dueDate}T09:00:00Z`).toISOString(),
    });

    await log(
      promise.id,
      "delivered",
      `Customer committed to pay on ${intent.dueDate} ("${intent.matched}"). ` +
        `Tracked as a promise-to-pay; no further chasing until then.`,
      "promise_to_pay_recorded",
    );
    console.info("[whatsapp-in] promise-to-pay recorded", {
      customer: customer.id,
      due: intent.dueDate,
    });
    return;
  }

  // "already paid", or anything we did not confidently understand: record it
  // and let a person read it.
  const latest = await latestEventForCustomer(customer.id);
  if (latest) {
    await log(
      latest.id,
      "escalated",
      intent.kind === "already_paid"
        ? `Customer says they have already paid. Needs a human to reconcile before any further contact.`
        : `Customer replied but the message was not confidently understood. Left for a human.`,
      intent.kind === "already_paid" ? "customer_claims_paid" : "reply_needs_human",
    );
  }
}

/** Twilio pings the endpoint when you save it in the console. */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ status: "ok", listening: "whatsapp-inbound" });
}

/**
 * Draft and send one reply, then record it as the agent's turn.
 *
 * Runs after the webhook has answered Twilio, so nothing here is on the
 * critical path and a failure costs a reply rather than a 500.
 */
async function replyToCustomer(customer: Customer): Promise<void> {
  if (!customer.phone) return;

  const merchant = await getMerchant(customer.merchant_id);
  if (!merchant || !merchant.active) return;

  // Every event of theirs, so the agent can answer "what about the other one?"
  const { data, error } = await db()
    .from("events")
    .select("*")
    .eq("customer_id", customer.id)
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) throw new Error(`Could not load their events: ${error.message}`);
  const events = (data ?? []) as RecoveryEvent[];

  const ctx: ConversationContext = {
    merchant,
    customer,
    events,
    turns: await conversationTurns(customer.id),
  };

  const outcome = await draftReply(ctx);
  if (outcome.kind === "skipped") {
    console.info("[whatsapp-in] no reply sent", {
      customer: customer.id,
      why: outcome.why,
    });
    return;
  }

  const result = await sendWhatsApp({
    merchantName: merchant.business_name,
    recipient: {
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
    },
    subject: null,
    body: outcome.reply.message,
    // The agent puts a link in the text itself when the conversation calls for
    // one; appending a second copy would read as a bot repeating itself.
    link: null,
  });

  // Attach the turn to the event the conversation is about, so the thread and
  // the recovery it belongs to stay in one place in the audit trail.
  const anchor = events[0];
  if (!anchor) return;

  await recordAction({
    eventId: anchor.id,
    merchantId: customer.merchant_id,
    channel: "whatsapp",
    message: `${REPLY_PREFIX}${outcome.reply.message}`,
    outcome: result.ok ? "sent" : "failed",
    response: result.ok ? (result.providerId ?? null) : (result.error ?? null),
    sentAt: new Date().toISOString(),
    decision: {
      root_cause: anchor.reason ?? "unknown",
      intervention: outcome.reply.needs_human ? "escalate_human" : "send_message",
      channel: "whatsapp",
      rationale: `Answered the customer about ${outcome.reply.topic}.${
        outcome.reply.needs_human ? " Flagged for a person to read." : ""
      }`,
      source: "agent",
      guardrail: outcome.reply.needs_human ? "reply_needs_human" : undefined,
    },
  });
}
