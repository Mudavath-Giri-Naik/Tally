/**
 * The Inbox queue: which cases count as "waiting on a person", and the
 * order they're worth looking at in.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildInbox, needsAttention } from "../src/lib/inbox";
import type { BoardRow, BoardStatus } from "../src/lib/board";

function row(over: Partial<BoardRow> = {}): BoardRow {
  return {
    event_id: "e1",
    customer_id: "c1",
    customer_name: "Asha",
    customer_email: "asha@example.com",
    customer_phone: "+919876543210",
    amount: 100000,
    reason: "gateway_timeout",
    reason_label: "Gateway timeout",
    reason_remedy: "Retry soon.",
    reason_retryable: true,
    status: "needs_human",
    attempts: 3,
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
    stop_reason: "risk_flagged",
    order_id: "order_1",
    ...over,
  };
}

describe("which cases wait on a person", () => {
  test("needs_human and disputed both do", () => {
    assert.equal(needsAttention(row({ status: "needs_human" })), true);
    assert.equal(needsAttention(row({ status: "disputed" })), true);
  });

  test("escalated to voice does not - the agent is still the one acting", () => {
    assert.equal(needsAttention(row({ status: "escalated_voice" })), false);
  });

  test("nothing that has already ended counts", () => {
    const ended: BoardStatus[] = ["recovered", "stopped", "opted_out", "written_off"];
    for (const status of ended) {
      assert.equal(needsAttention(row({ status })), false, status);
    }
  });

  test("an open case still being chased does not - it has not stopped yet", () => {
    assert.equal(needsAttention(row({ status: "chasing" })), false);
  });
});

describe("ranking the queue", () => {
  test("the largest amount at risk comes first", () => {
    const rows = [
      row({ event_id: "small", amount: 50000 }),
      row({ event_id: "big", amount: 500000 }),
      row({ event_id: "mid", amount: 150000 }),
    ];
    assert.deepEqual(
      buildInbox(rows).map((r) => r.event_id),
      ["big", "mid", "small"],
    );
  });

  test("cases not waiting on a person never appear, whatever they're worth", () => {
    const rows = [
      row({ event_id: "queued", status: "chasing", amount: 999999 }),
      row({ event_id: "stuck", status: "needs_human", amount: 100 }),
    ];
    assert.deepEqual(buildInbox(rows).map((r) => r.event_id), ["stuck"]);
  });

  test("a tie in amount breaks toward the older case, not load order", () => {
    const rows = [
      row({ event_id: "newer", amount: 100000, failed_on: "2026-09-05T00:00:00Z" }),
      row({ event_id: "older", amount: 100000, failed_on: "2026-09-01T00:00:00Z" }),
    ];
    assert.deepEqual(buildInbox(rows).map((r) => r.event_id), ["older", "newer"]);
  });

  test("a null amount sorts as if it were zero, never last by accident vs a real zero", () => {
    const rows = [
      row({ event_id: "unknown", amount: null }),
      row({ event_id: "zero", amount: 0 }),
      row({ event_id: "real", amount: 500 }),
    ];
    const order = buildInbox(rows).map((r) => r.event_id);
    assert.equal(order[0], "real");
    assert.ok(order.includes("unknown") && order.includes("zero"));
  });

  test("an empty board is an empty queue, not a crash", () => {
    assert.deepEqual(buildInbox([]), []);
  });
});
