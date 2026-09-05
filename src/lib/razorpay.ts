/**
 * Razorpay webhook payload handling.
 *
 * Razorpay sends a different entity shape per event, nested under
 * `payload.<entity>.entity`. This module flattens whichever one arrived into
 * the single normalised shape the rest of Tally works with, so nothing
 * downstream needs to know which webhook produced an event.
 */
import { classifyFailure, defaultCauseForType } from "./classify";
import type { EventType, RootCause } from "./types";

export interface RazorpayWebhook {
  event: string;
  account_id?: string;
  created_at?: number;
  payload?: Record<string, { entity?: Record<string, unknown> }>;
}

export interface NormalisedEvent {
  type: EventType;
  reason: RootCause;
  amount: number | null;
  currency: string;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  dueDate: string | null;
  metadata: Record<string, unknown>;
}

/** Razorpay event names Tally acts on. Anything else is acknowledged and dropped. */
const EVENT_TYPE_MAP: Record<string, EventType> = {
  "payment.failed": "payment_failed",
  "order.paid": "payment_failed", // recovery confirmation, handled specially
  "subscription.halted": "subscription_failed",
  "subscription.pending": "subscription_failed",
  "subscription.charged": "subscription_failed", // recovery confirmation
  "invoice.expired": "receivable_overdue",
  "subscription.cancelled": "subscription_failed",
};

/**
 * Event names that mean "this got paid", not "this failed". They resolve an
 * open event rather than creating one.
 */
export const RECOVERY_CONFIRMATION_EVENTS = new Set([
  "order.paid",
  "payment.captured",
  // Authorisation is the moment the money is committed; capture follows it.
  // Left out, it fell through to the catch-all below and was recorded as a
  // *failed* payment with no stated cause - a successful retry appearing on
  // the board as a second, broken-looking case.
  "payment.authorized",
  "subscription.charged",
  "invoice.paid",
]);

/**
 * Only the events Tally actually understands.
 *
 * This used to accept anything beginning "payment.", "subscription." or
 * "invoice." and hand it to normalise(), which defaults an unrecognised
 * event to payment_failed. So every payment.authorized, payment.pending or
 * dispute notification became a fabricated failed payment with reason
 * "unknown" - the comment above already said anything else is acknowledged
 * and dropped, and this is the code finally agreeing with it.
 */
export function isSupportedEvent(event: string): boolean {
  return event in EVENT_TYPE_MAP || RECOVERY_CONFIRMATION_EVENTS.has(event);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Pull the first present entity out of the payload envelope. */
function firstEntity(
  hook: RazorpayWebhook,
  preferred: string[],
): Record<string, unknown> {
  const payload = hook.payload ?? {};
  for (const key of preferred) {
    const e = payload[key]?.entity;
    if (e && typeof e === "object") return e as Record<string, unknown>;
  }
  for (const key of Object.keys(payload)) {
    const e = payload[key]?.entity;
    if (e && typeof e === "object") return e as Record<string, unknown>;
  }
  return {};
}

/**
 * Razorpay puts the customer's contact details in different places depending
 * on the entity and on how the merchant collected them. Look everywhere,
 * prefer the most specific.
 */
function extractContact(
  entity: Record<string, unknown>,
  payment: Record<string, unknown>,
): { name: string | null; email: string | null; phone: string | null } {
  const notes = (entity.notes ?? payment.notes ?? {}) as Record<string, unknown>;
  const customer = (entity.customer_details ??
    entity.customer ??
    {}) as Record<string, unknown>;

  const email =
    str(payment.email) ??
    str(entity.email) ??
    str(customer.email) ??
    str(notes.email) ??
    str(notes.customer_email);

  const phoneRaw =
    str(payment.contact) ??
    str(entity.contact) ??
    str(customer.contact) ??
    str(notes.contact) ??
    str(notes.phone) ??
    str(notes.customer_phone);

  // Last resort, and only that: the name on the card. A checkout that passes
  // nothing in notes still leaves this behind, so it is the difference
  // between addressing someone by name and addressing nobody - but it is the
  // cardholder, who is not always the person who placed the order, hence last.
  const card = (payment.card ?? entity.card ?? {}) as Record<string, unknown>;

  const name =
    str(customer.name) ??
    str(notes.name) ??
    str(notes.customer_name) ??
    str(entity.name) ??
    str(card.name);

  return { name, email, phone: normalisePhone(phoneRaw) };
}

/**
 * Twilio requires E.164. Razorpay commonly returns Indian numbers as
 * "9876543210" or "+91 98765 43210". Normalise, and give up rather than guess
 * for anything that is not recognisably Indian - a wrongly guessed country
 * code means messaging a stranger.
 */
export function normalisePhone(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) {
    return /^\+[1-9]\d{7,14}$/.test(digits) ? digits : null;
  }
  const bare = digits.replace(/^0+/, "");
  if (bare.length === 10 && /^[6-9]/.test(bare)) return `+91${bare}`;
  if (bare.length === 12 && bare.startsWith("91")) return `+${bare}`;
  return null;
}

export function normalise(hook: RazorpayWebhook): NormalisedEvent | null {
  const event = hook.event;
  if (!isSupportedEvent(event)) return null;

  const entity = firstEntity(hook, [
    "payment",
    "subscription",
    "invoice",
    "order",
  ]);
  const payment = (hook.payload?.payment?.entity ?? {}) as Record<
    string,
    unknown
  >;

  let type: EventType = EVENT_TYPE_MAP[event] ?? "payment_failed";
  if (event.startsWith("subscription.")) type = "subscription_failed";
  else if (event.startsWith("invoice.")) type = "receivable_overdue";

  // A halted subscription driven by a mandate failure is a mandate retry, not
  // a generic subscription failure - the sequencing is different (use case 5).
  const method = str(payment.method) ?? str(entity.method);
  if (
    (method === "upi" || method === "emandate" || method === "nach") &&
    (event === "subscription.halted" || event === "payment.failed") &&
    (payment.recurring === true || entity.recurring === true)
  ) {
    type = "mandate_retry";
  }

  const errorSurface = {
    error_code: str(payment.error_code) ?? str(entity.error_code),
    error_description:
      str(payment.error_description) ?? str(entity.error_description),
    error_reason: str(payment.error_reason) ?? str(entity.error_reason),
    error_source: str(payment.error_source) ?? str(entity.error_source),
    error_step: str(payment.error_step) ?? str(entity.error_step),
  };

  const hasError = Object.values(errorSurface).some((v) => v !== null);
  const reason: RootCause = hasError
    ? classifyFailure(errorSurface)
    : defaultCauseForType(type);

  const contact = extractContact(entity, payment);

  // If this payment went through a link Tally itself minted, the case it
  // belongs to is stamped right on it - see createRetryLink. Read before
  // trusting anything guessed from contact details.
  const notes = (payment.notes ?? entity.notes ?? {}) as Record<string, unknown>;
  const tallyEventId = str(notes.tally_event_id);

  const amount = num(payment.amount) ?? num(entity.amount) ?? null;

  const dueDateEpoch = num(entity.due_date) ?? num(entity.expire_by);
  const dueDate = dueDateEpoch
    ? new Date(dueDateEpoch * 1000).toISOString().slice(0, 10)
    : null;

  return {
    type,
    reason,
    amount,
    currency: str(payment.currency) ?? str(entity.currency) ?? "INR",
    customerName: contact.name,
    customerEmail: contact.email,
    customerPhone: contact.phone,
    dueDate,
    metadata: {
      razorpay_event: event,
      payment_id: str(payment.id) ?? str(entity.id),
      order_id: str(payment.order_id) ?? str(entity.order_id),
      tally_event_id: tallyEventId,
      subscription_id: str(entity.subscription_id) ?? (event.startsWith("subscription.") ? str(entity.id) : null),
      invoice_id: event.startsWith("invoice.") ? str(entity.id) : null,
      method,
      international: payment.international === true,
      // The details given on this order specifically. The customer record
      // holds one set and they are the latest, so without these every past
      // case on the board silently re-labels itself when someone reorders
      // under another name or a different address.
      customer_name: contact.name,
      customer_email: contact.email,
      customer_phone: contact.phone,
      ...errorSurface,
    },
  };
}

/** Razorpay's hard limit on payment-link reference_id. */
export const RAZORPAY_REFERENCE_ID_MAX = 40;

/** The reference_id Tally uses for an event attempt, within Razorpay's limit. */
export function retryLinkReference(eventId: string, attempts: number): string {
  return `t_${eventId.replace(/-/g, "")}_${attempts}`;
}

/**
 * The reference for a link an admin asked for, there and then.
 *
 * Deliberately not retryLinkReference: that one is keyed on the attempt,
 * which makes the worker's link creation idempotent - ask twice for one
 * attempt and Razorpay rejects the duplicate, which is exactly what should
 * happen to a retrying worker. An admin pressing "send me the link" a second
 * time means it, and on a case sitting at zero attempts the two requests
 * would otherwise be indistinguishable, so the second was always refused.
 */
export function adminLinkReference(eventId: string, now = Date.now()): string {
  return `a_${eventId.replace(/-/g, "").slice(0, 20)}_${now.toString(36)}`;
}

/**
 * A fresh payment link the customer can use to retry.
 *
 * Built with the *merchant's own* Razorpay credentials, so the money lands in
 * their account and the link carries their branding.
 */
export async function createRetryLink(opts: {
  keyId: string;
  keySecret: string;
  amount: number;
  currency?: string;
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  description: string;
  referenceId: string;
  /**
   * The case this link is for, stamped into the link's own notes.
   *
   * Razorpay copies a payment link's notes onto whatever payment is made
   * through it - so this is what lets any later webhook for that payment,
   * success or failure, be traced straight back to this exact case, instead
   * of guessed at from whatever name and email the payer happened to type in
   * at checkout. Without it, someone paying with different contact details
   * than the ones on file is a payment Tally cannot connect to anything.
   */
  eventId: string;
}): Promise<string> {
  // Razorpay rejects a reference_id over 40 characters with a 400. Catch it
  // here with a message that says what to do, rather than at the API boundary
  // where it reads as an opaque validation failure.
  if (opts.referenceId.length > RAZORPAY_REFERENCE_ID_MAX) {
    throw new Error(
      `Razorpay reference_id must be at most ${RAZORPAY_REFERENCE_ID_MAX} characters, ` +
        `got ${opts.referenceId.length} ("${opts.referenceId}").`,
    );
  }

  const auth = Buffer.from(`${opts.keyId}:${opts.keySecret}`).toString("base64");
  const res = await fetch("https://api.razorpay.com/v1/payment_links", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: opts.amount,
      currency: opts.currency ?? "INR",
      description: opts.description.slice(0, 2048),
      // Razorpay rejects a duplicate reference_id, which conveniently makes
      // link creation idempotent per event+attempt.
      reference_id: opts.referenceId,
      customer: {
        name: opts.customerName ?? undefined,
        email: opts.customerEmail ?? undefined,
        contact: opts.customerPhone ?? undefined,
      },
      notes: { tally_event_id: opts.eventId },
      notify: { sms: false, email: false }, // Tally does the notifying
      reminder_enable: false,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Razorpay payment link creation failed (${res.status}): ${body.slice(0, 300)}`,
    );
  }
  const json = (await res.json()) as { short_url?: string };
  if (!json.short_url) {
    throw new Error("Razorpay returned no short_url for the payment link");
  }
  return json.short_url;
}
