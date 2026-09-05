import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  classifyFailure,
  profileFor,
  defaultCauseForType,
  ROOT_CAUSE_PROFILES,
} from "../src/lib/classify";
import type { RootCause } from "../src/lib/types";

/** Shapes modelled on real Razorpay `payment.failed` error payloads. */
const CASES: Array<[label: string, err: object, expected: RootCause]> = [
  [
    "insufficient funds",
    {
      error_code: "BAD_REQUEST_ERROR",
      error_description: "Your card has insufficient funds.",
      error_reason: "insufficient_funds",
    },
    "insufficient_funds",
  ],
  [
    "expired card",
    {
      error_code: "BAD_REQUEST_ERROR",
      error_description: "Your card has expired.",
      error_reason: "card_expired",
    },
    "card_expired",
  ],
  [
    "blocked card",
    {
      error_description: "Card is blocked by the issuing bank",
      error_reason: "card_blocked",
    },
    "card_blocked",
  ],
  [
    "do-not-honour is a block, not a decline to retry",
    { error_description: "Do not honour", error_reason: "payment_failed" },
    "card_blocked",
  ],
  [
    "gateway timeout",
    {
      error_code: "GATEWAY_ERROR",
      error_description: "Payment processing timed out",
      error_reason: "payment_timeout",
    },
    "gateway_timeout",
  ],
  [
    "issuer down",
    {
      error_code: "GATEWAY_ERROR",
      error_description: "Issuer bank is unavailable right now",
      error_reason: "issuer_down",
    },
    "issuer_down",
  ],
  [
    "OTP not entered",
    {
      error_description: "OTP was not entered correctly",
      error_reason: "otp_incorrect",
    },
    "otp_failed",
  ],
  [
    "OTP attempts exceeded",
    { error_reason: "otp_attempts_exceeded" },
    "otp_failed",
  ],
  [
    "3DS authentication failure",
    {
      error_description: "3DS authentication failed",
      error_reason: "authentication_failed",
    },
    "authentication_failed",
  ],
  [
    "international card not allowed",
    {
      error_description: "International cards are not supported",
      error_reason: "international_transaction_not_allowed",
    },
    "international_declined",
  ],
  [
    "invalid CVV",
    { error_description: "Invalid cvv provided", error_reason: "incorrect_cvv" },
    "invalid_details",
  ],
  [
    "mandate revoked",
    { error_reason: "mandate_revoked", error_description: "Mandate revoked by customer" },
    "mandate_revoked",
  ],
  [
    "mandate amount exceeded",
    { error_description: "Debit amount exceeds mandate limit" },
    "mandate_limit_exceeded",
  ],
  [
    "risk decline",
    { error_description: "Payment blocked by risk checks", error_reason: "fraud_suspected" },
    "risk_declined",
  ],
];

describe("classifyFailure", () => {
  for (const [label, err, expected] of CASES) {
    test(`classifies ${label}`, () => {
      assert.equal(classifyFailure(err), expected);
    });
  }

  test("returns unknown rather than guessing when there is nothing to go on", () => {
    assert.equal(classifyFailure({}), "unknown");
    assert.equal(classifyFailure({ error_description: "" }), "unknown");
    assert.equal(
      classifyFailure({ error_description: "something went sideways" }),
      "unknown",
    );
  });

  test("specific rules beat generic ones", () => {
    // "International card declined" contains "declin" - it must not fall
    // through to a generic card decline, because the remedy is different.
    assert.equal(
      classifyFailure({
        error_description: "International card declined by issuer",
      }),
      "international_declined",
    );
    // A mandate failure mentioning a card must stay a mandate failure.
    assert.equal(
      classifyFailure({
        error_description: "Mandate revoked, card on file no longer usable",
      }),
      "mandate_revoked",
    );
  });

  test("a bare gateway error is still treated as systemic", () => {
    assert.equal(classifyFailure({ error_code: "GATEWAY_ERROR" }), "gateway_timeout");
  });

  describe("Razorpay's structured fields, when the prose says nothing", () => {
    // The single most common real payload: both text fields are the literal
    // word "failed" and carry no cause at all. Before the structured tier
    // this was the whole reason live events showed "Unknown failure".
    test("a generic payment_failed that died at authentication is an auth failure", () => {
      assert.equal(
        classifyFailure({
          error_code: "BAD_REQUEST_ERROR",
          error_description: "Payment failed",
          error_reason: "payment_failed",
          error_source: "customer",
          error_step: "payment_authentication",
        }),
        "authentication_failed",
      );
    });

    // The three shapes a live Razorpay account actually produced, all of
    // which used to land on "Unknown failure" in the dashboard.
    test("a cancelled checkout is an abandonment, not a failure", () => {
      assert.equal(
        classifyFailure({
          error_code: "BAD_REQUEST_ERROR",
          error_description:
            "Your payment has been cancelled. Try again or complete the payment later.",
          error_reason: "payment_cancelled",
          error_source: "customer",
          error_step: "payment_authentication",
        }),
        "customer_abandoned",
      );
    });

    test("a bare failure raised by the gateway is treated as systemic", () => {
      assert.equal(
        classifyFailure({
          error_code: "BAD_REQUEST_ERROR",
          error_description: "Payment failed",
          error_reason: "payment_failed",
          error_source: "gateway",
          error_step: "payment_authorization",
        }),
        "gateway_timeout",
      );
    });

    test("the customer being the source is not itself a cause", () => {
      // Nothing stated, and "customer" narrows nothing - it covers a cancel,
      // a typo and a decline alike. Unknown is the honest answer.
      assert.equal(
        classifyFailure({
          error_code: "BAD_REQUEST_ERROR",
          error_description: "Payment failed",
          error_reason: "payment_failed",
          error_source: "customer",
          error_step: "payment_authorization",
        }),
        "unknown",
      );
    });

    test("a technical error class is systemic even when the prose is empty", () => {
      assert.equal(
        classifyFailure({
          error_code: "GATEWAY_ERROR",
          error_description: "Payment failed",
          error_reason: "payment_failed",
          error_source: "bank",
          error_step: "payment_authorization",
        }),
        "gateway_timeout",
      );
    });

    test("a source alone never makes something systemic", () => {
      // "bank" sources an insufficient-funds decline exactly as it sources an
      // outage. With no technical error class and no stated cause, there is
      // genuinely nothing here to classify - and saying so is the point.
      assert.equal(
        classifyFailure({
          error_code: "BAD_REQUEST_ERROR",
          error_reason: "payment_failed",
          error_source: "bank",
          error_step: "payment_authorization",
        }),
        "unknown",
      );
    });

    test("stated prose still beats the structured fallback", () => {
      // Razorpay named the cause outright; the step must not override it.
      assert.equal(
        classifyFailure({
          error_description: "Your card has insufficient funds.",
          error_reason: "insufficient_funds",
          error_step: "payment_authentication",
        }),
        "insufficient_funds",
      );
    });

    test("gateway_technical_error is recognised despite the word in the middle", () => {
      assert.equal(
        classifyFailure({ error_reason: "gateway_technical_error" }),
        "gateway_timeout",
      );
    });

    test("a lapsed UPI collect is an approval never completed", () => {
      assert.equal(
        classifyFailure({ error_reason: "upi_collect_expired" }),
        "authentication_failed",
      );
    });
  });

  test("is case-insensitive", () => {
    assert.equal(
      classifyFailure({ error_description: "YOUR CARD HAS EXPIRED" }),
      "card_expired",
    );
  });
});

describe("root cause profiles", () => {
  test("every root cause has a profile", () => {
    const causes = new Set(CASES.map(([, , c]) => c));
    for (const c of causes) {
      assert.ok(ROOT_CAUSE_PROFILES[c], `missing profile for ${c}`);
    }
  });

  test("dead-end failures are never marked retryable", () => {
    // This is the guardrail behind use case 9. If any of these flips to
    // retryable, the agent will start retrying payments that cannot succeed.
    for (const cause of [
      "card_expired",
      "card_blocked",
      "mandate_revoked",
      "mandate_limit_exceeded",
      "international_declined",
      "risk_declined",
    ] as const) {
      assert.equal(
        profileFor(cause).retryable,
        false,
        `${cause} must not be retryable`,
      );
    }
  });

  test("infrastructure failures are marked systemic so messages do not blame the customer", () => {
    assert.equal(profileFor("gateway_timeout").systemic, true);
    assert.equal(profileFor("issuer_down").systemic, true);
    // And customer-side ones are not.
    assert.equal(profileFor("insufficient_funds").systemic, false);
    assert.equal(profileFor("card_expired").systemic, false);
  });

  test("insufficient funds waits before retrying instead of hammering", () => {
    assert.ok(
      profileFor("insufficient_funds").minRetryDelayHours >= 24,
      "retrying insufficient funds within a day is spam",
    );
  });

  test("a simple slip retries immediately", () => {
    assert.equal(profileFor("otp_failed").minRetryDelayHours, 0);
    assert.equal(profileFor("otp_failed").retryable, true);
  });
});

describe("defaultCauseForType", () => {
  test("non-payment events get a sensible cause", () => {
    assert.equal(defaultCauseForType("cart_abandoned"), "customer_abandoned");
    assert.equal(defaultCauseForType("receivable_overdue"), "invoice_unpaid");
    assert.equal(defaultCauseForType("promise_to_pay"), "invoice_unpaid");
    assert.equal(
      defaultCauseForType("payment_link_expired"),
      "payment_link_expired",
    );
    assert.equal(defaultCauseForType("cod_refused"), "cod_refused");
  });
});
