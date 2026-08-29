/** Shared domain types. These mirror the tables in supabase/schema.sql. */

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
  /** Where the decision came from - the model, or a rule that pre-empted it. */
  source: "agent" | "guardrail" | "schedule";
  model?: string;
  scheduled_for?: string | null;
}

export type Intervention =
  | "send_message" // contact the customer on some channel
  | "schedule_retry" // wait, then try again later
  | "request_new_method" // retrying cannot work; ask for a different card/UPI
  | "escalate_human" // stop automating, flag for a person
  | "stop"; // opted out, cap reached, or unrecoverable

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
