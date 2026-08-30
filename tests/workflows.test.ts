/**
 * Workflows: which of the four handles an event, and what a merchant's
 * business type pre-checks.
 *
 * The mapping is the load-bearing part. It decides both what the merchant is
 * shown in the table's Workflow column and whether the agent is allowed to
 * act at all, so a wrong answer here is either a mislabelled row or silence
 * on a case the merchant expected to be chased.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  workflowFor,
  workflowEnabled,
  normaliseWorkflows,
  workflowsForBusinessType,
  BUSINESS_TYPES,
  WORKFLOW_IDS,
  WORKFLOWS,
  DEFAULT_WORKFLOWS,
} from "../src/lib/workflows";

describe("mapping an event to its workflow", () => {
  test("files each event type under the workflow that owns it", () => {
    assert.equal(workflowFor("cart_abandoned", "customer_abandoned"), "checkout_abandonment");
    assert.equal(workflowFor("payment_failed", "insufficient_funds"), "failed_payment");
    assert.equal(workflowFor("subscription_failed", "unknown"), "subscription_autopay");
    assert.equal(workflowFor("mandate_retry", "unknown"), "subscription_autopay");
    assert.equal(workflowFor("receivable_overdue", "invoice_unpaid"), "overdue_invoice");
  });

  test("the event type, not the cause, separates an abandoned checkout from a decline", () => {
    // The same OTP failure means two different things: walking away mid-OTP is
    // an abandoned checkout, while a submitted payment that failed OTP is a
    // decline. Only the type can tell those apart, so it has to win.
    assert.equal(workflowFor("cart_abandoned", "otp_failed"), "checkout_abandonment");
    assert.equal(workflowFor("payment_failed", "otp_failed"), "failed_payment");
    assert.equal(
      workflowFor("cart_abandoned", "authentication_failed"),
      "checkout_abandonment",
    );
  });

  test("a mandate failure is auto-pay wherever it surfaces", () => {
    // Razorpay reports some mandate failures as a plain payment.failed, so
    // going by type alone would file a revoked AutoPay mandate under failed
    // payments - and a SaaS merchant who turned that category off would stop
    // hearing about their own churn.
    assert.equal(workflowFor("payment_failed", "mandate_revoked"), "subscription_autopay");
    assert.equal(
      workflowFor("payment_failed", "mandate_limit_exceeded"),
      "subscription_autopay",
    );
  });

  test("promise-to-pay belongs to no workflow, so no toggle can suppress it", () => {
    // It is raised by the customer committing to a date in conversation. A
    // promise they made should not be dropped because a category switch is off.
    assert.equal(workflowFor("promise_to_pay", "invoice_unpaid"), null);
    assert.equal(workflowEnabled([], null), true);
  });

  test("every event type maps somewhere, so no case is silently unclassified", () => {
    const types = [
      "payment_failed",
      "subscription_failed",
      "cart_abandoned",
      "promise_to_pay",
      "receivable_overdue",
      "mandate_retry",
    ] as const;
    for (const t of types) {
      const w = workflowFor(t, "unknown");
      assert.ok(
        w === null || WORKFLOW_IDS.includes(w),
        `${t} produced ${w}, which is not a workflow`,
      );
    }
  });
});

describe("the gate the agent consults", () => {
  test("lets an event through only when its workflow is on", () => {
    assert.equal(workflowEnabled(["failed_payment"], "failed_payment"), true);
    assert.equal(workflowEnabled(["failed_payment"], "overdue_invoice"), false);
    assert.equal(workflowEnabled([], "failed_payment"), false);
  });
});

describe("business type pre-checks", () => {
  test("each type turns on the workflows that business actually has", () => {
    assert.deepEqual(workflowsForBusinessType("ecommerce"), [
      "checkout_abandonment",
      "failed_payment",
    ]);
    assert.deepEqual(workflowsForBusinessType("saas"), [
      "failed_payment",
      "subscription_autopay",
    ]);
    // Most B2B sellers take card payments too, so failed payments comes on
    // alongside the invoice chasing.
    assert.deepEqual(workflowsForBusinessType("b2b"), [
      "overdue_invoice",
      "failed_payment",
    ]);
    assert.deepEqual(workflowsForBusinessType("mixed"), WORKFLOW_IDS);
  });

  test("no business type is left with nothing switched on", () => {
    for (const b of BUSINESS_TYPES) {
      assert.ok(b.workflows.length > 0, `${b.id} enables nothing`);
    }
  });

  test("a preset never returns the shared array, so editing one cannot edit the source", () => {
    const picked = workflowsForBusinessType("mixed");
    picked.pop();
    assert.equal(workflowsForBusinessType("mixed").length, WORKFLOW_IDS.length);
  });
});

describe("normalising what arrives from a form or an old row", () => {
  test("drops anything that is not a workflow", () => {
    assert.deepEqual(
      normaliseWorkflows(["failed_payment", "nonsense", 7, null]),
      ["failed_payment"],
    );
  });

  test("returns them in one fixed order, whatever order they arrived in", () => {
    // The settings screen and the pills both render straight from this, so a
    // merchant's toggles must not reshuffle themselves after a save.
    assert.deepEqual(
      normaliseWorkflows(["overdue_invoice", "checkout_abandonment"]),
      ["checkout_abandonment", "overdue_invoice"],
    );
  });

  test("de-duplicates rather than repeating a workflow", () => {
    assert.deepEqual(normaliseWorkflows(["failed_payment", "failed_payment"]), [
      "failed_payment",
    ]);
  });

  test("a non-array is empty, not a crash", () => {
    assert.deepEqual(normaliseWorkflows(null), []);
    assert.deepEqual(normaliseWorkflows("failed_payment"), []);
    assert.deepEqual(normaliseWorkflows(undefined), []);
  });
});

describe("the definitions themselves", () => {
  test("every workflow has copy for all three places it is rendered", () => {
    for (const id of WORKFLOW_IDS) {
      const w = WORKFLOWS[id];
      assert.ok(w.label.length > 0, `${id} has no label`);
      assert.ok(w.summary.length > 0, `${id} has no summary`);
      assert.ok(w.covers.length > 0, `${id} has no covers line`);
    }
  });

  test("the default is everything, so an unanswered question never loses revenue", () => {
    assert.deepEqual(DEFAULT_WORKFLOWS, WORKFLOW_IDS);
  });
});
