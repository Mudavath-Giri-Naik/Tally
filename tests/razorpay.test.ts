import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  normalise,
  normalisePhone,
  isSupportedEvent,
  RECOVERY_CONFIRMATION_EVENTS,
  retryLinkReference,
  RAZORPAY_REFERENCE_ID_MAX,
} from "../src/lib/razorpay";
import { randomUUID } from "node:crypto";

/** A realistic payment.failed envelope. */
function paymentFailed(overrides: Record<string, unknown> = {}) {
  return {
    event: "payment.failed",
    payload: {
      payment: {
        entity: {
          id: "pay_ABC123",
          amount: 250000,
          currency: "INR",
          order_id: "order_XYZ",
          method: "card",
          email: "asha@example.com",
          contact: "+919876543210",
          error_code: "BAD_REQUEST_ERROR",
          error_description: "Your card has insufficient funds.",
          error_reason: "insufficient_funds",
          notes: { customer_name: "Asha Rao" },
          ...overrides,
        },
      },
    },
  };
}

describe("normalise", () => {
  test("flattens a payment.failed into a classified event", () => {
    const n = normalise(paymentFailed())!;
    assert.equal(n.type, "payment_failed");
    assert.equal(n.reason, "insufficient_funds");
    assert.equal(n.amount, 250000);
    assert.equal(n.currency, "INR");
    assert.equal(n.customerEmail, "asha@example.com");
    assert.equal(n.customerPhone, "+919876543210");
    assert.equal(n.metadata.payment_id, "pay_ABC123");
    assert.equal(n.metadata.order_id, "order_XYZ");
  });

  test("a recurring UPI failure becomes a mandate retry, not a plain failure", () => {
    // Use case 5: the sequencing for a failed auto-debit is different from a
    // one-off card failure, so it must not be classified as the same thing.
    const hook = {
      event: "payment.failed",
      payload: {
        payment: {
          entity: {
            id: "pay_M1",
            amount: 99900,
            method: "upi",
            recurring: true,
            email: "b@example.com",
            error_reason: "insufficient_funds",
          },
        },
      },
    };
    assert.equal(normalise(hook)!.type, "mandate_retry");
  });

  test("a non-recurring UPI failure stays a plain payment failure", () => {
    const hook = {
      event: "payment.failed",
      payload: {
        payment: {
          entity: {
            id: "pay_M2",
            method: "upi",
            recurring: false,
            email: "b@example.com",
            error_reason: "insufficient_funds",
          },
        },
      },
    };
    assert.equal(normalise(hook)!.type, "payment_failed");
  });

  test("subscription.halted becomes a subscription failure", () => {
    const hook = {
      event: "subscription.halted",
      payload: {
        subscription: {
          entity: { id: "sub_1", customer_details: { email: "c@example.com" } },
        },
      },
    };
    const n = normalise(hook)!;
    assert.equal(n.type, "subscription_failed");
    assert.equal(n.metadata.subscription_id, "sub_1");
  });

  test("invoice.expired becomes an overdue receivable with its due date", () => {
    const dueEpoch = Math.floor(Date.UTC(2026, 0, 15) / 1000);
    const hook = {
      event: "invoice.expired",
      payload: {
        invoice: {
          entity: {
            id: "inv_1",
            amount: 5000000,
            due_date: dueEpoch,
            customer_details: { email: "ops@acme.com", name: "Acme Ltd" },
          },
        },
      },
    };
    const n = normalise(hook)!;
    assert.equal(n.type, "receivable_overdue");
    assert.equal(n.reason, "invoice_unpaid");
    assert.equal(n.dueDate, "2026-01-15");
    assert.equal(n.customerName, "Acme Ltd");
  });

  test("finds contact details hidden in notes", () => {
    const hook = {
      event: "payment.failed",
      payload: {
        payment: {
          entity: {
            id: "pay_N",
            error_reason: "card_expired",
            notes: { customer_email: "notes@example.com", phone: "9876543210" },
          },
        },
      },
    };
    const n = normalise(hook)!;
    assert.equal(n.customerEmail, "notes@example.com");
    assert.equal(n.customerPhone, "+919876543210");
  });

  test("falls back to the name on the card when the checkout passed no notes", () => {
    // A storefront that prefills nothing still leaves the cardholder name
    // behind. Without this the case reads as "Unknown" in the dashboard.
    const hook = {
      event: "payment.failed",
      payload: {
        payment: {
          entity: {
            id: "pay_C",
            email: "buyer@example.com",
            error_reason: "payment_failed",
            error_step: "payment_authentication",
            card: { name: "Priya Menon", last4: "1111" },
          },
        },
      },
    };
    const n = normalise(hook)!;
    assert.equal(n.customerName, "Priya Menon");
    // The same payload's step is what saves it from "unknown".
    assert.equal(n.reason, "authentication_failed");
  });

  test("a name passed in notes still beats the one on the card", () => {
    const hook = {
      event: "payment.failed",
      payload: {
        payment: {
          entity: {
            id: "pay_D",
            email: "buyer@example.com",
            notes: { customer_name: "Priya M" },
            card: { name: "P MENON" },
          },
        },
      },
    };
    assert.equal(normalise(hook)!.customerName, "Priya M");
  });

  test("a failure with no error fields still classifies as unknown, not a crash", () => {
    const hook = {
      event: "payment.failed",
      payload: { payment: { entity: { id: "pay_Q", email: "q@example.com" } } },
    };
    const n = normalise(hook)!;
    assert.equal(n.reason, "unknown");
  });

  test("returns null for events Tally does not act on", () => {
    assert.equal(normalise({ event: "account.updated" }), null);
    assert.equal(isSupportedEvent("account.updated"), false);
  });

  test("survives a payload with no entity at all", () => {
    const n = normalise({ event: "payment.failed", payload: {} });
    assert.ok(n, "should still produce an event rather than throwing");
    assert.equal(n!.amount, null);
    assert.equal(n!.customerEmail, null);
  });
});

describe("normalisePhone", () => {
  test("normalises Indian formats to E.164", () => {
    assert.equal(normalisePhone("9876543210"), "+919876543210");
    assert.equal(normalisePhone("+91 98765 43210"), "+919876543210");
    assert.equal(normalisePhone("919876543210"), "+919876543210");
    assert.equal(normalisePhone("09876543210"), "+919876543210");
    assert.equal(normalisePhone("+919876543210"), "+919876543210");
  });

  test("keeps other valid international numbers as given", () => {
    assert.equal(normalisePhone("+14155551234"), "+14155551234");
  });

  test("refuses to guess rather than risk messaging a stranger", () => {
    // A 10-digit number starting with 1-5 is not a valid Indian mobile, so we
    // cannot assume +91. Returning null is correct - better no message than a
    // message to the wrong person.
    assert.equal(normalisePhone("1234567890"), null);
    assert.equal(normalisePhone("12345"), null);
    assert.equal(normalisePhone(""), null);
    assert.equal(normalisePhone(null), null);
    assert.equal(normalisePhone("not a phone"), null);
  });
});

describe("retry link reference id", () => {
  test("stays within Razorpay's 40-character limit", () => {
    // Regression: "tally_" + a 36-char UUID + "_0" is 44 characters, and
    // Razorpay rejects the whole payment link with a 400. Every recovery email
    // then went out promising a link that was not there.
    for (let i = 0; i < 200; i++) {
      const ref = retryLinkReference(randomUUID(), i);
      assert.ok(
        ref.length <= RAZORPAY_REFERENCE_ID_MAX,
        `reference_id ${ref} is ${ref.length} chars, over the ${RAZORPAY_REFERENCE_ID_MAX} limit`,
      );
    }
  });

  test("is unique per event and per attempt", () => {
    const a = randomUUID();
    const b = randomUUID();
    assert.notEqual(retryLinkReference(a, 0), retryLinkReference(a, 1));
    assert.notEqual(retryLinkReference(a, 0), retryLinkReference(b, 0));
    // Stable for the same input, so a worker retry reuses the same link.
    assert.equal(retryLinkReference(a, 2), retryLinkReference(a, 2));
  });
});

describe("success events must never become failures", () => {
  test("payment.authorized is a confirmation, not a failed payment", () => {
    // This exact hook created a second, broken-looking case on the board:
    // it fell through a "payment.*" catch-all into normalise(), which
    // defaults an unrecognised event to payment_failed with no cause.
    assert.equal(RECOVERY_CONFIRMATION_EVENTS.has("payment.authorized"), true);
  });

  test("an unrecognised payment event is dropped, not invented into a failure", () => {
    for (const e of [
      "payment.pending",
      "payment.dispute.created",
      "subscription.updated",
      "invoice.partially_paid",
    ]) {
      assert.equal(isSupportedEvent(e), false, `${e} must not be acted on`);
    }
  });

  test("the events Tally does act on are still supported", () => {
    for (const e of [
      "payment.failed",
      "order.paid",
      "payment.captured",
      "subscription.halted",
      "invoice.expired",
    ]) {
      assert.equal(isSupportedEvent(e), true, `${e} must still be handled`);
    }
  });

  test("the name given on an order is kept with that order", () => {
    // The customer record holds one name and it is the latest, so without
    // this every past case re-labels itself when someone reorders.
    const hook = {
      event: "payment.failed",
      payload: {
        payment: {
          entity: {
            id: "pay_N1",
            error_reason: "payment_failed",
            notes: { customer_name: "Jimmy" },
          },
        },
      },
    };
    assert.equal(normalise(hook)!.metadata.customer_name, "Jimmy");
  });

  test("the contact details given on an order are kept with that order", () => {
    // Identity is still shared - one email or phone is one customer - but the
    // board must show what this order carried, not the newest details on the
    // record, or every past case re-labels itself on the next order.
    const n = normalise(
      paymentFailed({ email: "jimmy@example.com", contact: "9876500011" }),
    )!;
    assert.equal(n.metadata.customer_email, "jimmy@example.com");
    assert.equal(n.metadata.customer_phone, "+919876500011");
  });

  test("an order with no contact details stores nothing rather than a blank", () => {
    const hook = {
      event: "payment.failed",
      payload: { payment: { entity: { id: "pay_Z", error_reason: "card_expired" } } },
    };
    const n = normalise(hook)!;
    assert.equal(n.metadata.customer_email, null);
    assert.equal(n.metadata.customer_phone, null);
  });
});
