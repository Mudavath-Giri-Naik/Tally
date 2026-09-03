import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  withinContactWindow,
  nextWindowOpen,
  preflight,
  clamp,
  availableChannels,
  computeNextAttempt,
  nextSalaryCreditWindow,
  mandateRetrySchedule,
  isHighValue,
  HIGH_VALUE_PAISE,
  type DecisionContext,
  type AgentChoice,
} from "../src/lib/agent/rules";
import type { Merchant, RecoveryEvent, Customer, Action } from "../src/lib/types";

function merchant(over: Partial<Merchant> = {}): Merchant {
  return {
    id: "m1",
    business_name: "Mandate",
    slug: "mandate",
    razorpay_key_id: "enc",
    razorpay_key_secret: "enc",
    webhook_secret: "w",
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

function event(over: Partial<RecoveryEvent> = {}): RecoveryEvent {
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

function customer(over: Partial<Customer> = {}): Customer {
  return {
    id: "c1",
    merchant_id: "m1",
    name: "Asha",
    email: "asha@example.com",
    phone: "+919876543210",
    opted_out: false,
    opted_out_at: null,
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function ctx(over: Partial<DecisionContext> = {}): DecisionContext {
  return {
    merchant: merchant(),
    event: event(),
    customer: customer(),
    priorActions: [],
    siblingEvents: [],
    priorFailureCount: 0,
    // 12:00 IST = 06:30 UTC, comfortably inside the window.
    now: new Date("2026-03-10T06:30:00Z"),
    ...over,
  };
}

const choice = (over: Partial<AgentChoice> = {}): AgentChoice => ({
  intervention: "send_message",
  channel: "whatsapp",
  message: "Hi Asha, your payment did not go through.",
  rationale: "Standard first nudge.",
  ...over,
});

describe("contact window", () => {
  test("recognises inside and outside the window in the merchant's timezone", () => {
    const m = merchant();
    // 06:30 UTC = 12:00 IST -> inside
    assert.equal(withinContactWindow(m, new Date("2026-03-10T06:30:00Z")), true);
    // 01:00 UTC = 06:30 IST -> before 08:00, outside
    assert.equal(withinContactWindow(m, new Date("2026-03-10T01:00:00Z")), false);
    // 16:00 UTC = 21:30 IST -> after 19:00, outside
    assert.equal(withinContactWindow(m, new Date("2026-03-10T16:00:00Z")), false);
  });

  test("the window is evaluated in the merchant's zone, not the server's", () => {
    // 20:00 UTC is the middle of the night in India but mid-afternoon in NY.
    const at = new Date("2026-03-10T20:00:00Z");
    assert.equal(withinContactWindow(merchant(), at), false);
    assert.equal(
      withinContactWindow(merchant({ timezone: "America/New_York" }), at),
      true,
    );
  });

  test("nextWindowOpen lands at 08:00 local, later the same day", () => {
    // 01:00 UTC = 06:30 IST, so the window opens at 08:00 IST = 02:30 UTC.
    const open = nextWindowOpen(merchant(), new Date("2026-03-10T01:00:00Z"));
    assert.equal(open.toISOString(), "2026-03-10T02:30:00.000Z");
  });

  test("nextWindowOpen rolls to tomorrow once the window has closed", () => {
    // 16:00 UTC = 21:30 IST on the 10th -> next open is 08:00 IST on the 11th.
    const open = nextWindowOpen(merchant(), new Date("2026-03-10T16:00:00Z"));
    assert.equal(open.toISOString(), "2026-03-11T02:30:00.000Z");
  });

  test("a time already inside the window returns unchanged", () => {
    const now = new Date("2026-03-10T06:30:00Z");
    assert.equal(nextWindowOpen(merchant(), now).getTime(), now.getTime());
  });

  test("handles a window that wraps past midnight", () => {
    const m = merchant({ contact_window_start: "22:00", contact_window_end: "06:00" });
    // 18:00 UTC = 23:30 IST -> inside the wrapped window
    assert.equal(withinContactWindow(m, new Date("2026-03-10T18:00:00Z")), true);
    // 06:30 UTC = 12:00 IST -> outside
    assert.equal(withinContactWindow(m, new Date("2026-03-10T06:30:00Z")), false);
  });
});

describe("preflight stops", () => {
  test("an opted-out customer is stopped instantly with nothing sent", () => {
    const stop = preflight(ctx({ customer: customer({ opted_out: true }) }));
    assert.equal(stop?.intervention, "stop");
    assert.equal(stop?.stopReason, "customer_opted_out");
  });

  test("a held-back event is stopped, and says so as a control", () => {
    const stop = preflight(ctx({ event: event({ holdout: true }) }));
    assert.equal(stop?.intervention, "stop");
    assert.equal(stop?.stopReason, "holdout_control");
  });

  test("opting out beats the control arm - a held-back case is not special", () => {
    const stop = preflight(
      ctx({ event: event({ holdout: true }), customer: customer({ opted_out: true }) }),
    );
    assert.equal(stop?.stopReason, "customer_opted_out");
  });

  test("an unreachable customer never enters the control arm", () => {
    // Otherwise the control fills with people who could not have been reached
    // either way, and the comparison stops measuring the agent at all.
    const stop = preflight(
      ctx({
        event: event({ holdout: true }),
        customer: customer({ email: null, phone: null }),
      }),
    );
    assert.equal(stop?.stopReason, "no_contact_details");
  });

  test("the attempt cap is enforced", () => {
    assert.equal(preflight(ctx({ event: event({ attempts: 2 }) })), null);
    const stop = preflight(ctx({ event: event({ attempts: 3 }) }));
    assert.equal(stop?.stopReason, "max_attempts_reached");
  });

  test("respects a merchant's lower attempt cap", () => {
    const stop = preflight(
      ctx({ merchant: merchant({ max_attempts: 1 }), event: event({ attempts: 1 }) }),
    );
    assert.equal(stop?.stopReason, "max_attempts_reached");
  });

  test("a customer with no contact details is stopped", () => {
    const stop = preflight(
      ctx({ customer: customer({ email: null, phone: null }) }),
    );
    assert.equal(stop?.stopReason, "no_contact_details");
  });

  test("risk declines escalate to a human rather than being automated around", () => {
    const stop = preflight(ctx({ event: event({ reason: "risk_declined" }) }));
    assert.equal(stop?.intervention, "escalate_human");
    assert.equal(stop?.stopReason, "risk_flagged");
  });

  test("repeat failures across cycles escalate to a human (use case 14)", () => {
    assert.equal(preflight(ctx({ priorFailureCount: 2 })), null);
    const stop = preflight(ctx({ priorFailureCount: 3 }));
    assert.equal(stop?.intervention, "escalate_human");
    assert.equal(stop?.stopReason, "repeat_failure_across_cycles");
  });

  test("a normal first-time failure is allowed through", () => {
    assert.equal(preflight(ctx()), null);
  });
});

describe("channel selection", () => {
  test("only offers channels the merchant enabled and the customer can receive", () => {
    assert.deepEqual(
      availableChannels(ctx({ merchant: merchant({ channels_enabled: ["email"] }) })),
      ["email"],
    );
    assert.deepEqual(
      availableChannels(ctx({ customer: customer({ phone: null }) })),
      ["email"],
    );
    assert.deepEqual(
      availableChannels(ctx({ customer: customer({ email: null }) })),
      ["whatsapp", "voice"],
    );
  });

  test("a call is not offered for an amount too small to justify one", () => {
    const channels = availableChannels(ctx({ event: event({ amount: 9900 }) }));
    assert.ok(!channels.includes("voice"));
    assert.ok(channels.includes("whatsapp"));
  });

  test("a call is offered once the amount is worth one", () => {
    assert.ok(
      availableChannels(ctx({ event: event({ amount: 250000 }) })).includes("voice"),
    );
  });

  test("an amount we do not know does not earn a call", () => {
    assert.ok(
      !availableChannels(ctx({ event: event({ amount: null }) })).includes("voice"),
    );
  });

  test("escalates rather than repeating the channel that already failed", () => {
    const prior: Action = {
      id: "a1",
      event_id: "e1",
      merchant_id: "m1",
      channel: "email",
      message: "first try",
      sent_at: "2026-03-09T10:00:00Z",
      response: null,
      cost_paise: 3,
      outcome: "sent",
      decision: null,
      created_at: "2026-03-09T10:00:00Z",
    };
    const available = availableChannels(ctx({ priorActions: [prior] }));
    assert.ok(!available.includes("email"), "should not send email twice in a row");
  });
});

describe("clamp", () => {
  test("never retries a cause that cannot succeed (use case 9)", () => {
    const d = clamp(
      choice({ intervention: "schedule_retry" }),
      ctx({ event: event({ reason: "card_expired" }) }),
    );
    assert.equal(d.intervention, "request_new_method");
    assert.match(d.guardrail!, /not retryable/);
  });

  test("the same override applies to a revoked mandate", () => {
    const d = clamp(
      choice({ intervention: "schedule_retry" }),
      ctx({ event: event({ reason: "mandate_revoked" }) }),
    );
    assert.equal(d.intervention, "request_new_method");
  });

  test("allows a retry when the cause genuinely is retryable", () => {
    const d = clamp(
      choice({ intervention: "schedule_retry" }),
      ctx({ event: event({ reason: "gateway_timeout" }) }),
    );
    assert.equal(d.intervention, "schedule_retry");
    assert.equal(d.guardrail, undefined);
    assert.ok(d.scheduledFor, "a retry must carry a scheduled time");
  });

  test("defers a message that would land outside the contact window", () => {
    const d = clamp(choice(), ctx({ now: new Date("2026-03-10T20:00:00Z") }));
    assert.equal(d.send, false, "must not send outside the window");
    assert.equal(d.intervention, "schedule_retry");
    // A short code for the badge - the merchant-facing explanation, with a
    // time in their own zone rather than a bare ISO stamp, lives in rationale.
    assert.equal(d.guardrail, "outside_contact_window");
    assert.match(d.rationale, /contact window/);
    assert.match(d.rationale, /next attempt is scheduled for/i);
    // 20:00 UTC = 01:30 IST on the 11th -> defers to 08:00 IST that morning.
    assert.equal(d.scheduledFor!.toISOString(), "2026-03-11T02:30:00.000Z");
  });

  test("sends normally inside the window", () => {
    const d = clamp(choice(), ctx());
    assert.equal(d.send, true);
    assert.equal(d.channel, "whatsapp");
    assert.equal(d.source, "agent");
  });

  test("falls back when the model picks a channel that is not available", () => {
    const d = clamp(
      choice({ channel: "voice" }),
      ctx({ merchant: merchant({ channels_enabled: ["email"] }) }),
    );
    assert.equal(d.channel, "email");
    assert.match(d.guardrail!, /unavailable/);
  });

  test("stops when no channel is usable at all", () => {
    const d = clamp(
      choice(),
      ctx({ customer: customer({ email: null, phone: null }) }),
    );
    assert.equal(d.intervention, "stop");
    assert.equal(d.send, false);
  });

  test("high-value failures prefer voice when the model does not choose (use case 15)", () => {
    const d = clamp(
      choice({ channel: null }),
      ctx({ event: event({ amount: HIGH_VALUE_PAISE + 1 }) }),
    );
    assert.equal(d.channel, "voice");
  });

  test("low-value failures prefer a cheap channel", () => {
    const d = clamp(choice({ channel: null }), ctx({ event: event({ amount: 20000 }) }));
    assert.equal(d.channel, "whatsapp");
  });

  test("stop and escalate decisions never carry a channel", () => {
    assert.equal(clamp(choice({ intervention: "stop" }), ctx()).channel, null);
    assert.equal(
      clamp(choice({ intervention: "escalate_human" }), ctx()).channel,
      null,
    );
  });

  test("every override is recorded in the audit trail", () => {
    const d = clamp(
      choice({ intervention: "schedule_retry" }),
      ctx({ event: event({ reason: "card_expired" }) }),
    );
    assert.equal(d.source, "guardrail");
    assert.ok(d.guardrail, "an override must say why");
    assert.equal(d.root_cause, "card_expired");
  });
});

describe("retry scheduling", () => {
  test("insufficient funds waits for a salary date, not a few hours (use case 8)", () => {
    const now = new Date("2026-03-10T06:30:00Z");
    const when = computeNextAttempt(ctx({ now }));
    // Next salary day after a 48h minimum from 10 Mar is the 15th.
    assert.equal(when.toISOString(), "2026-03-15T04:30:00.000Z"); // 10:00 IST
    assert.ok(
      when.getTime() - now.getTime() > 48 * 3600_000,
      "must respect the minimum delay",
    );
  });

  test("salary window rolls into next month when none remain", () => {
    const when = nextSalaryCreditWindow(
      new Date("2026-03-20T06:30:00Z"),
      "Asia/Kolkata",
      48,
    );
    assert.equal(when.toISOString(), "2026-04-01T04:30:00.000Z");
  });

  test("mandate retries widen with each attempt (use case 5)", () => {
    const now = new Date("2026-03-10T06:30:00Z");
    const first = mandateRetrySchedule(0, now, "Asia/Kolkata");
    const second = mandateRetrySchedule(1, now, "Asia/Kolkata");
    const third = mandateRetrySchedule(2, now, "Asia/Kolkata");

    assert.equal(first.getTime() - now.getTime(), 24 * 3600_000);
    assert.equal(second.getTime() - now.getTime(), 72 * 3600_000);
    assert.ok(
      third.getTime() > second.getTime(),
      "the final attempt should wait longest",
    );
  });

  test("a systemic outage is retried soon, and backs off if it persists", () => {
    const now = new Date("2026-03-10T06:30:00Z");
    const firstTry = computeNextAttempt(
      ctx({ now, event: event({ reason: "gateway_timeout", attempts: 0 }) }),
    );
    const secondTry = computeNextAttempt(
      ctx({ now, event: event({ reason: "gateway_timeout", attempts: 1 }) }),
    );
    assert.equal(firstTry.getTime() - now.getTime(), 1 * 3600_000);
    assert.equal(secondTry.getTime() - now.getTime(), 2 * 3600_000);
  });

  test("backoff is capped so an event never disappears for months", () => {
    const now = new Date("2026-03-10T06:30:00Z");
    const late = computeNextAttempt(
      ctx({ now, event: event({ reason: "gateway_timeout", attempts: 20 }) }),
    );
    assert.ok(late.getTime() - now.getTime() <= 168 * 3600_000);
  });
});

describe("isHighValue", () => {
  test("splits on the threshold", () => {
    assert.equal(isHighValue(event({ amount: HIGH_VALUE_PAISE })), true);
    assert.equal(isHighValue(event({ amount: HIGH_VALUE_PAISE - 1 })), false);
    assert.equal(isHighValue(event({ amount: null })), false);
  });
});
