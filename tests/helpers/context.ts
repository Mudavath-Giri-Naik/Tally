/** Shared fixtures so each test only states what it actually cares about. */
import type { DecisionContext } from "../../src/lib/agent/rules";
import type {
  Merchant,
  RecoveryEvent,
  Customer,
  Action,
} from "../../src/lib/types";

export function makeMerchant(over: Partial<Merchant> = {}): Merchant {
  return {
    id: "m1",
    business_name: "Mandate",
    slug: "mandate",
    razorpay_key_id: "enc",
    razorpay_key_secret: "enc",
    webhook_secret: "whsec",
    whatsapp_number: null,
    voice_number: null,
    contact_window_start: "08:00",
    contact_window_end: "19:00",
    timezone: "Asia/Kolkata",
    max_attempts: 3,
    channels_enabled: ["email", "whatsapp", "voice"],
    holdout_percent: 0,
    workflows_enabled: [
      "checkout_abandonment",
      "failed_payment",
      "subscription_autopay",
      "overdue_invoice",
    ],
    ai_provider: null,
    ai_model: null,
  active: true,
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

export function makeEvent(over: Partial<RecoveryEvent> = {}): RecoveryEvent {
  return {
    id: "e1",
    merchant_id: "m1",
    customer_id: "c1",
    type: "payment_failed",
    reason: "insufficient_funds",
    amount: 250000,
    currency: "INR",
    status: "processing",
    due_date: null,
    claimed_by: "w1",
    claimed_at: null,
    provider_event_id: "evt1",
    next_attempt_at: null,
    attempts: 0,
    stop_reason: null,
    recovered_amount: null,
    metadata: {},
    holdout: false,
    paused: false,
    hold_until: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

export function makeCustomer(over: Partial<Customer> = {}): Customer {
  return {
    id: "c1",
    merchant_id: "m1",
    name: "Asha",
    email: "asha@example.com",
    phone: "+919876543210",
    opted_out: false,
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

export function makeAction(over: Partial<Action> = {}): Action {
  return {
    id: "a1",
    event_id: "e1",
    merchant_id: "m1",
    channel: "email",
    message: "Earlier reminder",
    sent_at: "2026-03-09T10:00:00Z",
    response: null,
    outcome: "sent",
    decision: null,
    cost_paise: 0,
    created_at: "2026-03-09T10:00:00Z",
    ...over,
  };
}

export interface ContextOverrides {
  merchant?: Partial<Merchant>;
  event?: Partial<RecoveryEvent>;
  customer?: Partial<Customer> | null;
  priorActions?: Array<Partial<Action>>;
  siblingEvents?: Array<Partial<RecoveryEvent>>;
  priorFailureCount?: number;
  now?: Date;
}

export function makeContext(over: ContextOverrides = {}): DecisionContext {
  return {
    merchant: makeMerchant(over.merchant),
    event: makeEvent(over.event),
    customer: over.customer === null ? null : makeCustomer(over.customer),
    priorActions: (over.priorActions ?? []).map(makeAction),
    siblingEvents: (over.siblingEvents ?? []).map(makeEvent),
    priorFailureCount: over.priorFailureCount ?? 0,
    // Midday IST - inside the default contact window.
    now: over.now ?? new Date("2026-03-10T06:30:00Z"),
  };
}
