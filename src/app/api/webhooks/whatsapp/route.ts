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
  latestSummary,
  REPLY_PREFIX,
  type ConversationContext,
} from "@/lib/agent/converse";
import type { AgentReply } from "@/lib/agent/providers";
import {
  decideMove,
  pendingPrompt,
  type DialogueMove,
} from "@/lib/agent/dialogue";
import { classifyReply as classify } from "@/lib/inbound";
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

    // Read what the agent last asked BEFORE recording this message, because
    // recording it makes *it* the newest row - and then the question this
    // message is answering can no longer be seen. That is what made a menu
    // choice fall through to the conversational agent: by the time the reply
    // was drafted, no menu appeared to be pending.
    const pending = new Map<string, string | null>();
    for (const customer of customers) {
      pending.set(customer.id, await pendingPrompt(customer.id).catch(() => null));
    }

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
          await replyToCustomer(customer, body, pending.get(customer.id) ?? null).catch((err) => {
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

/**
 * The one thing that must be handled synchronously, before the async reply
 * path even runs: an explicit opt-out.
 *
 * Everything else a customer's message could mean - a promise to pay, an
 * already-paid claim, an open question - is now decided once, by
 * `decideMove`/`performScriptedMove` inside `after()`. That used to not be
 * true: this function also used to book its own promise-to-pay event and log
 * its own escalation for "already paid" or an unrecognised reply, in parallel
 * with the async path doing the same classification and acting on it too.
 * Two systems independently deciding "this looks like a promise" produced two
 * promise_to_pay rows for one message, one of them booked with no
 * provider_event_id to dedupe against - which is exactly the duplicate rows
 * and repeated confirmations this was rewritten to stop.
 */
async function handle(
  customer: Customer,
  intent: ReturnType<typeof classifyReply>,
  body: string,
  params: Record<string, string>,
): Promise<void> {
  if (intent.kind !== "opt_out") return;

  const messageSid = params.MessageSid ?? params.SmsMessageSid ?? null;
  const stopped = await optOutCustomer(customer.id);
  const latest = await latestEventForCustomer(customer.id);
  if (latest) {
    await recordAction({
      eventId: latest.id,
      merchantId: customer.merchant_id,
      channel: "whatsapp",
      message: `[inbound] ${body}`,
      outcome: "no_action",
      response: messageSid,
      sentAt: new Date().toISOString(),
      decision: {
        root_cause: "unknown",
        intervention: "stop",
        channel: "whatsapp",
        rationale:
          `Customer replied "${intent.matched}". Opted out and stopped ${stopped} open event(s). ` +
          `They will not be contacted again on any channel.`,
        source: "guardrail",
        guardrail: "customer_opted_out",
      },
    });
  }
  console.info("[whatsapp-in] opt-out honoured", { customer: customer.id, stopped });
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
async function replyToCustomer(
  customer: Customer,
  body: string,
  pending: string | null,
): Promise<void> {
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

  // Most turns in a dunning conversation are not open-ended - a greeting wants
  // a menu, a menu choice wants the thing it selected, "I'll pay later" wants
  // one question back. Those are answered from a script: no tokens, and the
  // same input always produces the same effect.
  const move = decideMove({
    merchant,
    customer,
    events,
    body,
    intent: classify(body, new Date(), merchant.timezone),
    pending,
  });

  if (move.kind !== "converse") {
    await performScriptedMove(move, merchant, customer, events, body);
    return;
  }

  const [turns, earlierSummary] = await Promise.all([
    conversationTurns(customer.id),
    // What the agent already knows about this customer from before the turns
    // above - without it, its memory stops dead at the turn cap.
    latestSummary(customer.id).catch(() => null),
  ]);

  const ctx: ConversationContext = {
    merchant,
    customer,
    events,
    turns,
    earlierSummary,
  };

  const outcome = await draftReply(ctx);
  if (outcome.kind === "skipped") {
    console.info("[whatsapp-in] no reply sent", {
      customer: customer.id,
      why: outcome.why,
    });
    return;
  }

  // A fallback is still a reply as far as the customer is concerned, so it
  // goes out the same way - but it is always flagged for a person, because
  // nobody has actually answered the question yet.
  const reply: AgentReply =
    outcome.kind === "fallback"
      ? { message: outcome.message, needs_human: true, topic: "awaiting a reply" }
      : outcome.reply;

  if (outcome.kind === "fallback") {
    console.error("[whatsapp-in] model unavailable, sent holding reply", {
      customer: customer.id,
      error: outcome.error,
    });
  }

  const result = await sendWhatsApp({
    merchantName: merchant.business_name,
    recipient: {
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
    },
    subject: null,
    body: reply.message,
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
    message: `${REPLY_PREFIX}${reply.message}`,
    outcome: result.ok ? "sent" : "failed",
    response: result.ok ? (result.providerId ?? null) : (result.error ?? null),
    sentAt: new Date().toISOString(),
    decision: {
      root_cause: anchor.reason ?? "unknown",
      intervention: reply.needs_human ? "escalate_human" : "send_message",
      channel: "whatsapp",
      rationale:
        outcome.kind === "fallback"
          ? `Could not reach the model (${outcome.error.slice(0, 120)}). Sent a holding reply and flagged it.`
          : `Answered the customer about ${reply.topic}.${
              reply.needs_human ? " Flagged for a person to read." : ""
            }`,
      source: "agent",
      guardrail: outcome.kind === "fallback"
        ? "model_unavailable"
        : reply.needs_human
          ? "reply_needs_human"
          : undefined,
    },
  });
}

/**
 * Send a scripted move and record it.
 *
 * The `prompt` on the move is written to the action's guardrail, which is how
 * the next inbound message knows what question it is answering - a menu that
 * is not recorded is a menu whose replies mean nothing.
 */
async function performScriptedMove(
  move: Exclude<DialogueMove, { kind: "converse" }>,
  merchant: Merchant,
  customer: Customer,
  events: RecoveryEvent[],
  body: string,
): Promise<void> {
  const anchor = events[0];

  if (move.kind === "opt_out") {
    // Reached only when a menu number selected it; a typed STOP was already
    // handled inline. Either way the customer is not messaged again, so there
    // is no confirmation to send.
    const stopped = await optOutCustomer(customer.id);
    if (anchor) {
      await recordAction({
        eventId: anchor.id,
        merchantId: customer.merchant_id,
        channel: null,
        message: null,
        outcome: "no_action",
        decision: {
          root_cause: anchor.reason ?? "unknown",
          intervention: "stop",
          channel: null,
          rationale:
            `Customer chose "stop these messages" from the menu. Opted out and ` +
            `stopped ${stopped} open event(s). They will not be contacted again.`,
          source: "guardrail",
          guardrail: "customer_opted_out",
        },
      });
    }
    console.info("[whatsapp-in] opt-out via menu", { customer: customer.id, stopped });
    return;
  }

  let text: string;
  let prompt: string | undefined;
  let bookedEventId: string | null = null;

  if (move.kind === "promise") {
    const { updateEvent } = await import("@/lib/events");

    // A customer who says "I'll pay Friday" and then "actually Monday" has
    // ONE promise that moved, not two promises. Creating a second row each
    // time is what filled the dashboard with what looked like duplicate
    // customers - one line per restatement of the same commitment.
    const existingPromise = events.find(
      (e) =>
        e.type === "promise_to_pay" &&
        (e.status === "queued" || e.status === "processing"),
    );

    if (existingPromise) {
      await updateEvent(existingPromise.id, {
        due_date: move.dueDate,
        next_attempt_at: new Date(`${move.dueDate}T09:00:00Z`).toISOString(),
      });
      bookedEventId = existingPromise.id;
    } else {
      const promise = await ingestEvent({
        merchantId: customer.merchant_id,
        providerEventId: null,
        type: "promise_to_pay",
        reason: "invoice_unpaid",
        amount: anchor?.amount ?? null,
        dueDate: move.dueDate,
        customerName: customer.name,
        customerEmail: customer.email,
        customerPhone: customer.phone,
        metadata: {
          source: "whatsapp_reply",
          promised_on: new Date().toISOString().slice(0, 10),
          due_date: move.dueDate,
          reply_text: body.slice(0, 500),
          origin_event_id: anchor?.id ?? null,
        },
      });
      await updateEvent(promise.id, {
        next_attempt_at: new Date(`${move.dueDate}T09:00:00Z`).toISOString(),
      });
      bookedEventId = promise.id;
    }

    text = move.text;
    prompt = "promise_to_pay_recorded";
  } else {
    text = move.text;
    prompt = move.prompt;
  }

  const result = await sendWhatsApp({
    merchantName: merchant.business_name,
    recipient: { name: customer.name, email: customer.email, phone: customer.phone },
    subject: null,
    body: text,
    link: null,
  });

  const eventId = bookedEventId ?? anchor?.id;
  if (!eventId) return;

  await recordAction({
    eventId,
    merchantId: customer.merchant_id,
    channel: "whatsapp",
    message: `${REPLY_PREFIX}${text}`,
    outcome: result.ok ? "sent" : "failed",
    response: result.ok ? (result.providerId ?? null) : (result.error ?? null),
    sentAt: new Date().toISOString(),
    decision: {
      root_cause: anchor?.reason ?? "unknown",
      intervention:
        prompt === "reply_needs_human" || prompt === "customer_claims_paid"
          ? "escalate_human"
          : "send_message",
      channel: "whatsapp",
      rationale:
        move.kind === "promise"
          ? `Customer committed to pay on ${move.dueDate}. Tracked as a promise-to-pay; no chasing until then.`
          : `Scripted reply. Awaiting: ${prompt ?? "nothing in particular"}.`,
      // "schedule" rather than "agent": no model chose this, a rule did.
      source: "schedule",
      guardrail: prompt,
    },
  });
}
