/**
 * workflowStats: what the Workflows tab actually shows underneath the
 * toggles - a fold over the same board rows the table renders, grouped by
 * the category a merchant switches on or off.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { workflowStats } from "../src/lib/board";
import { WORKFLOW_IDS } from "../src/lib/workflows";
import type { BoardRow } from "../src/lib/board";

function row(over: Partial<BoardRow> = {}): BoardRow {
  return {
    event_id: "e1",
    customer_id: "c1",
    customer_name: "Asha",
    customer_email: "asha@example.com",
    customer_phone: "+919876543210",
    amount: 100000,
    recovered_amount: null,
    reason: "gateway_timeout",
    reason_label: "Gateway timeout",
    reason_remedy: "Retry soon.",
    reason_retryable: true,
    status: "chasing",
    attempts: 1,
    max_attempts: 3,
    failed_on: "2026-09-01T00:00:00Z",
    recovered_at: null,
    last_channel: "email",
    channels_used: ["email"],
    event_type: "payment_failed",
    workflow: "failed_payment",
    paused: false,
    hold_until: null,
    next_attempt_at: null,
    stop_reason: null,
    order_id: "order_1",
    ...over,
  };
}

describe("workflowStats", () => {
  test("returns one row for every workflow, even one with nothing chased yet", () => {
    const stats = workflowStats([]);
    assert.deepEqual(
      stats.map((s) => s.workflow),
      WORKFLOW_IDS,
    );
    for (const s of stats) {
      assert.equal(s.customers, 0);
      assert.equal(s.amount_recovered, 0);
      assert.equal(s.recovery_rate, 0);
    }
  });

  test("counts distinct customers per workflow, not events", () => {
    const rows = [
      row({ workflow: "failed_payment", customer_id: "c1" }),
      // Same customer, a second failure - still one customer.
      row({ workflow: "failed_payment", customer_id: "c1", event_id: "e2" }),
      row({ workflow: "failed_payment", customer_id: "c2", event_id: "e3" }),
    ];
    const stats = workflowStats(rows);
    const fp = stats.find((s) => s.workflow === "failed_payment")!;
    assert.equal(fp.customers, 2);
  });

  test("a customer with no id known does not inflate the count", () => {
    const rows = [row({ workflow: "failed_payment", customer_id: null })];
    const stats = workflowStats(rows);
    assert.equal(stats.find((s) => s.workflow === "failed_payment")!.customers, 0);
  });

  test("sums the amount actually recovered, not the amount that failed", () => {
    const rows = [
      row({
        workflow: "checkout_abandonment",
        status: "recovered",
        amount: 100000,
        recovered_amount: 90000,
      }),
      // No provider figure - falls back to the amount that failed.
      row({
        workflow: "checkout_abandonment",
        status: "recovered",
        amount: 50000,
        recovered_amount: null,
        event_id: "e2",
        customer_id: "c2",
      }),
      // Still open - not counted as recovered revenue yet.
      row({
        workflow: "checkout_abandonment",
        status: "chasing",
        amount: 999999,
        event_id: "e3",
        customer_id: "c3",
      }),
    ];
    const stats = workflowStats(rows);
    const ca = stats.find((s) => s.workflow === "checkout_abandonment")!;
    assert.equal(ca.amount_recovered, 140000);
  });

  test("recovery rate excludes written-off cases from both sides, same as the dashboard's own", () => {
    const rows = [
      row({ workflow: "overdue_invoice", status: "recovered", event_id: "e1", customer_id: "c1" }),
      row({ workflow: "overdue_invoice", status: "chasing", event_id: "e2", customer_id: "c2" }),
      row({ workflow: "overdue_invoice", status: "written_off", event_id: "e3", customer_id: "c3" }),
    ];
    const stats = workflowStats(rows);
    const oi = stats.find((s) => s.workflow === "overdue_invoice")!;
    // 1 recovered of 2 concluded-or-open (written off dropped from the count).
    assert.equal(oi.recovery_rate, 50);
  });

  test("a workflow with nothing but a written-off case reads as zero, not a division error", () => {
    const rows = [row({ workflow: "subscription_autopay", status: "written_off" })];
    const stats = workflowStats(rows);
    assert.equal(stats.find((s) => s.workflow === "subscription_autopay")!.recovery_rate, 0);
  });

  test("a promise-to-pay row belongs to no workflow's stats", () => {
    const rows = [row({ workflow: null, status: "recovered", amount: 999999 })];
    const stats = workflowStats(rows);
    for (const s of stats) assert.equal(s.amount_recovered, 0);
  });

  test("never mixes one workflow's rows into another's", () => {
    const rows = [
      row({ workflow: "failed_payment", status: "recovered", amount: 10000 }),
      row({
        workflow: "overdue_invoice",
        status: "recovered",
        amount: 99999999,
        event_id: "e2",
        customer_id: "c2",
      }),
    ];
    const stats = workflowStats(rows);
    assert.equal(stats.find((s) => s.workflow === "failed_payment")!.amount_recovered, 10000);
    assert.equal(
      stats.find((s) => s.workflow === "overdue_invoice")!.amount_recovered,
      99999999,
    );
  });
});
