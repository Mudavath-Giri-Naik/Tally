/** Shared domain types. These mirror the tables in supabase/schema.sql. */

import type { WorkflowId } from "./workflows";

export type { WorkflowId };

export type EventType =
  | "payment_failed"
  | "subscription_failed"
  | "cart_abandoned"
  | "promise_to_pay"
  | "receivable_overdue"
  | "mandate_retry";

export type EventStatus =
  | "queued"
  | "processing"
  | "recovered"
  | "unrecoverable"
  | "stopped";

export type Channel = "email" | "whatsapp" | "voice";

export type ActionOutcome =
  | "pending"
  | "sent"
  | "delivered"
  | "failed"
  | "skipped"
  | "no_action"
  | "escalated";

/**
 * Why a payment actually failed, normalised across Razorpay's many error
 * codes. This is the root cause the recovery strategy keys off - the whole
 * point of use case 1 is that the fix matches the reason.
 */
export type RootCause =
  | "insufficient_funds"
  | "card_expired"
  | "card_blocked"
  | "invalid_details"
  | "otp_failed"
  | "authentication_failed"
  | "international_declined"
  | "gateway_timeout"
  | "issuer_down"
  | "risk_declined"
  | "mandate_revoked"
  | "mandate_limit_exceeded"
  | "customer_abandoned"
  | "invoice_unpaid"
  | "unknown";

export interface Merchant {
  id: string;
  business_name: string;
  /** URL-safe name, unique across merchants. Assigned by a database trigger. */
  slug: string;
  razorpay_key_id: string; // encrypted at rest
  razorpay_key_secret: string; // encrypted at rest
  webhook_secret: string;
  whatsapp_number: string | null; // encrypted at rest
  voice_number: string | null; // encrypted at rest
  contact_window_start: string; // 'HH:MM:SS'
  contact_window_end: string;
  timezone: string;
  max_attempts: number;
  channels_enabled: Channel[];
  /**
   * Share of this merchant's customers held back from contact entirely, as an
   * untouched control arm. Zero means every case is chased and the recovery
   * figure has nothing to be compared against.
   */
  holdout_percent: number;
  /** Which of the four recovery workflows this merchant runs. */
  workflows_enabled: WorkflowId[];
  /**
   * Which model backend this business runs on. Null means the platform
   * default, so a merchant created before this existed keeps working.
   *
   * The choice is the provider, not the key: keys are the operator's own cost
   * and live in a shared pool (see lib/ai-keys).
   */
  ai_provider: string | null;
  /**
   * The model within that provider, or null for its default. Separate from
   * the provider because quota is counted per model - moving to another one
   * is a way out of a throttle, not just a preference.
   */
  ai_model: string | null;
  active: boolean;
  created_at: string;
}

export interface Customer {
  id: string;
  merchant_id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  opted_out: boolean;
  created_at: string;
}

export interface RecoveryEvent {
  id: string;
  merchant_id: string;
  customer_id: string | null;
  type: EventType;
  reason: RootCause | null;
  amount: number | null; // paise
  currency: string;
  status: EventStatus;
  due_date: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  provider_event_id: string | null;
  next_attempt_at: string | null;
  attempts: number;
  stop_reason: string | null;
  recovered_amount: number | null;
  metadata: Record<string, unknown>;
  /**
   * Assigned to the untouched control arm: never contacted, still measured.
   * Decided once at ingest so an event cannot drift between arms.
   */
  holdout: boolean;
  // [+] admin overrides: suppress automation without changing status (paused)
  // or before a fixed date (hold_until), independent of the retry backoff.
  paused: boolean;
  hold_until: string | null;
  created_at: string;
  updated_at: string;
}

export interface Action {
  id: string;
  event_id: string;
  merchant_id: string;
  channel: Channel | null;
  message: string | null;
  sent_at: string | null;
  response: string | null;
  outcome: ActionOutcome;
  decision: DecisionRecord | null;
  /** What this attempt cost to send, in paise. Zero if nothing went out. */
  cost_paise: number;
  created_at: string;
}

/** The full "why" behind one action, written to actions.decision. */
export interface DecisionRecord {
  root_cause: RootCause;
  intervention: Intervention;
  channel: Channel | null;
  rationale: string;
  /** Which guardrail fired, if the agent's choice was overridden. */
  guardrail?: string;
  /** Where the decision came from - the model, a rule that pre-empted it, or
   *  a merchant clicking a kebab-menu action rather than waiting on either. */
  /**
   * Who produced this row. "customer" is the one that is not a decision at
   * all - it is their own words, recorded so the trail holds both halves of
   * a conversation rather than only what we said into it.
   */
  source: "agent" | "guardrail" | "schedule" | "admin" | "customer";
  model?: string;
  scheduled_for?: string | null;
  /** Which override this was, when source is "admin" - see AdminActionId. */
  admin_action?: AdminActionId;
  /**
   * The address or number this actually went out to.
   *
   * Recorded rather than re-derived. The panel used to label a sent email
   * with whatever the case resolves to *now*, which is a different question
   * from where it went *then* - and the two gave different answers, so the
   * trail confidently named a recipient that had never received it. An audit
   * row that reports what it did is worth more than one that recomputes what
   * it would do.
   */
  sent_to?: string | null;
}

export type Intervention =
  | "send_message" // contact the customer on some channel
  | "schedule_retry" // wait, then try again later
  | "request_new_method" // retrying cannot work; ask for a different card/UPI
  | "escalate_human" // stop automating, flag for a person
  | "stop" // opted out, cap reached, or unrecoverable
  | "admin_override"; // a merchant intervened by hand - see admin_action for which

/**
 * The manual interventions a merchant can take from the customer table's
 * kebab menu, independent of (and able to override) the automated flow.
 */
export type AdminActionId =
  | "mark_paid"
  | "pause_outreach"
  | "resume_outreach"
  | "escalate_human"
  | "flag_disputed"
  | "snooze"
  | "trigger_next_step"
  | "write_off"
  | "opt_out"
  | "reopen_case";

/**
 * The contact details one case came in with.
 *
 * Stamped into the event's metadata at ingest, alongside the customer record
 * the event is filed under. The two are not the same thing and are not
 * supposed to be - see contactFor.
 */
export interface ContactDetails {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
}

/** Non-empty strings only: a blank in metadata is an absence, not an address. */
function present(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** What one event's metadata says about who it is for. */
export function caseContacts(event: Pick<RecoveryEvent, "metadata">): ContactDetails {
  const md = (event.metadata ?? {}) as Record<string, unknown>;
  return {
    name: present(md.customer_name),
    email: present(md.customer_email),
    phone: present(md.customer_phone),
  };
}

/**
 * Who to actually contact about one case.
 *
 * The customer record is an identity - it is what an opt-out, a repeat-failure
 * count and a WhatsApp thread all hang off, and it is found by matching either
 * email or phone. Its own email and phone columns are gap-filled: whichever
 * arrived first stays, because those columns carry unique indexes and
 * overwriting one can collide with another customer's row. That is a sound
 * rule for an identity key and a bad one for a delivery address.
 *
 * So the two drifted apart. A second order from the same phone under a
 * different email is filed under the same customer, and that customer's email
 * column still holds the first address - while the board, which reads the
 * event's own details first, displays the second. The panel named one
 * recipient and the mail went to the other, which is not a cosmetic
 * disagreement: it is someone else's payment reminder, with their amount and
 * their pay link, arriving in the wrong inbox.
 *
 * The case wins, because the case is the thing being answered. Identity still
 * comes from the record - opted_out and id are kept exactly as they are, so
 * this can never route around an opt-out - and a case that carries no details
 * of its own falls back to the record, which is the old behaviour.
 *
 * Deliberately the same precedence the board renders with
 * (coalesce(metadata->>'customer_email', c.email) in event_board), so what a
 * merchant reads on the row is by construction where the message goes.
 */
export function contactFor(
  contacts: ContactDetails,
  customer: Customer | null,
): Customer | null {
  if (!customer) return null;
  const name = present(contacts.name);
  const email = present(contacts.email);
  const phone = present(contacts.phone);
  if (!name && !email && !phone) return customer;
  return {
    ...customer,
    name: name ?? customer.name,
    email: email ?? customer.email,
    phone: phone ?? customer.phone,
  };
}

/** Money is always paise internally. Format only at the edges. */
export function formatINR(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return "-";
  const rupees = paise / 100;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: rupees % 1 === 0 ? 0 : 2,
  }).format(rupees);
}
