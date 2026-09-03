/**
 * The live progress strip.
 *
 * What is pinned here is mostly restraint. Every step that says it is done has
 * to be backed by a row that says so, exactly one step may claim to be
 * happening now, and a case that has ended must not still be advertising a
 * next attempt. A progress strip that overstates is worse than none: it is the
 * one part of the panel a merchant will believe without checking.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildJourney, countdown, journeyProgress } from "../src/lib/journey";
import type { BoardRow, TimelineEntry } from "../src/lib/board";

const NOW = new Date("2026-09-03T10:00:00Z");

function row(over: Partial<BoardRow> = {}): BoardRow {
  return {
    event_id: "e1",
    customer_id: "c1",
    customer_name: "Asha",
    customer_email: "asha@example.com",
    customer_phone: "+919876543210",
    amount: 129900,
    reason: "gateway_timeout",
    reason_label: "Gateway timeout",
    reason_remedy: "Retry soon.",
    reason_retryable: true,
    status: "chasing",
    attempts: 1,
    max_attempts: 3,
    failed_on: "2026-09-03T09:00:00Z",
    recovered_at: null,
    last_channel: "email",
    channels_used: ["email"],
    event_type: "payment_failed",
    workflow: "failed_payment",
    paused: false,
    hold_until: null,
    next_attempt_at: "2026-09-03T13:00:00Z",
    stop_reason: null,
    order_id: "order_X1",
    ...over,
  };
}

function entry(over: Partial<TimelineEntry> = {}): TimelineEntry {
  return {
    id: Math.random().toString(36).slice(2),
    created_at: "2026-09-03T09:01:00Z",
    sent_at: "2026-09-03T09:01:00Z",
    channel: "email",
    outcome: "sent",
    message: "Hi Asha, your payment failed.",
    intervention: "send_message",
    rationale: "A systemic failure. Apologise and offer a retry link.",
    guardrail: null,
    in_window: true,
    admin_action: null,
    source: "agent",
    response: "resend-id-1",
    sent_to: "asha@example.com",
    ...over,
  };
}

describe("the steps every case has", () => {
  test("numbers run from one with no gaps", () => {
    const steps = buildJourney(row(), [entry()], NOW);
    steps.forEach((s, i) => assert.equal(s.n, i + 1));
  });

  test("opens with the failure, the webhook, the cause and the case", () => {
    const steps = buildJourney(row(), [], NOW);
    assert.match(steps[0].title, /payment failed/i);
    assert.equal(steps[1].code, "200 OK");
    assert.match(steps[2].detail ?? "", /Gateway timeout/);
    assert.equal(steps[4].code, "QUEUED");
  });

  test("says plainly when retrying the same method cannot work", () => {
    const steps = buildJourney(row({ reason_retryable: false }), [], NOW);
    assert.match(steps[2].detail ?? "", /cannot work/);
  });

  test("a customer with no contact details is a failed step, not a done one", () => {
    const steps = buildJourney(
      row({ customer_email: null, customer_phone: null }), [], NOW,
    );
    const matched = steps.find((s) => s.title.includes("matched"));
    assert.equal(matched?.state, "failed");
    assert.equal(matched?.code, "MISSING");
  });
});

describe("attempts", () => {
  test("a send becomes a decision step and a sent step", () => {
    const steps = buildJourney(row(), [entry()], NOW);
    assert.ok(steps.some((s) => /Attempt 1 — the agent chose an email/.test(s.title)));
    const sent = steps.find((s) => s.title === "Attempt 1 was sent");
    assert.equal(sent?.code, "SENT");
    assert.equal(sent?.detail, "To asha@example.com");
  });

  test("credits a rule rather than the agent when a rule decided", () => {
    const steps = buildJourney(row(), [entry({ source: "guardrail" })], NOW);
    assert.equal(steps.find((s) => /the agent chose/.test(s.title))?.code, "RULE");
  });

  test("a guardrail that adjusted the send gets its own step", () => {
    const steps = buildJourney(row(), [entry({ guardrail: "outside_contact_window" })], NOW);
    const g = steps.find((s) => s.title === "A guardrail adjusted it");
    assert.equal(g?.detail, "outside contact window");
  });

  test("a failed send says so, and carries the provider's reason", () => {
    const steps = buildJourney(
      row(), [entry({ outcome: "failed", response: "Mailbox does not exist", sent_at: null })], NOW,
    );
    const f = steps.find((s) => s.state === "failed");
    assert.equal(f?.code, "FAILED");
    assert.equal(f?.detail, "Mailbox does not exist");
  });

  test("a message sent outside the window admits it", () => {
    const steps = buildJourney(row(), [entry({ in_window: false })], NOW);
    assert.match(
      steps.find((s) => s.title === "Attempt 1 was sent")?.detail ?? "",
      /outside your contact window/,
    );
  });

  test("three attempts produce three sent steps, in order", () => {
    const steps = buildJourney(
      row({ attempts: 3 }),
      [
        entry({ created_at: "2026-09-03T09:01:00Z" }),
        entry({ created_at: "2026-09-03T09:30:00Z", channel: "whatsapp" }),
        entry({ created_at: "2026-09-03T09:45:00Z", channel: "voice" }),
      ],
      NOW,
    );
    for (const n of [1, 2, 3]) {
      assert.ok(steps.some((s) => s.title === `Attempt ${n} was sent`), `attempt ${n}`);
    }
  });

  test("a customer reply appears as its own step", () => {
    const steps = buildJourney(
      row(), [entry(), entry({ message: "[inbound] what happened?", channel: null })], NOW,
    );
    const r = steps.find((s) => s.code === "REPLY");
    assert.equal(r?.detail, "what happened?");
  });

  test("a case blocked before any send shows why, and sends nothing", () => {
    const steps = buildJourney(
      row({ status: "stopped", stop_reason: "customer_opted_out" }),
      [entry({
        channel: null, outcome: "no_action", sent_at: null,
        rationale: "The customer has opted out of contact.",
      })],
      NOW,
    );
    const stop = steps.find((s) => s.title === "A rule stopped it here");
    assert.equal(stop?.state, "skipped");
    assert.equal(stop?.detail, "The customer has opted out of contact.");
    // Preflight never let it through, so it must not claim the checks passed.
    assert.ok(!steps.some((s) => s.title === "Safety checks passed"));
    assert.ok(!steps.some((s) => /was sent/.test(s.title)));
  });

  test("a tick that deliberately held off is a step, not a silence", () => {
    // The regression: a sibling-suppressed pass produced no step at all, so
    // the strip jumped from "case opened" to "waiting" and read as though
    // nothing had happened.
    const steps = buildJourney(
      row(),
      [entry({
        channel: "whatsapp", outcome: "skipped", sent_at: null,
        guardrail: "coordinated_with_sibling_event",
        rationale: "Another open case for this customer was messaged recently.",
      })],
      NOW,
    );
    const held = steps.find((s) => s.code === "HELD");
    assert.equal(held?.title, "The agent held off this time");
    assert.match(held?.detail ?? "", /messaged recently/);
    // It got past preflight to be held, so the checks did pass.
    assert.ok(steps.some((s) => s.title === "Safety checks passed"));
  });

  test("an escalation by rule is its own step", () => {
    const steps = buildJourney(
      row({ status: "needs_human", stop_reason: "risk_flagged" }),
      [entry({
        channel: null, outcome: "escalated", sent_at: null,
        rationale: "Blocked by fraud checks. A person needs to look at this.",
      })],
      NOW,
    );
    assert.ok(steps.some((s) => s.title === "A rule handed it to a person"));
  });
});

describe("what is happening right now", () => {
  test("never claims more than one step is live", () => {
    for (const r of [
      row(),
      row({ next_attempt_at: "2026-09-03T09:30:00Z" }),
      row({ next_attempt_at: null }),
      row({ paused: true }),
      row({ status: "recovered", recovered_at: "2026-09-03T09:50:00Z" }),
    ]) {
      const live = buildJourney(r, [entry()], NOW).filter((s) => s.state === "active");
      assert.ok(live.length <= 1, `${live.length} live steps`);
    }
  });

  test("a due attempt reads as running, not as waiting", () => {
    const steps = buildJourney(row({ next_attempt_at: "2026-09-03T09:30:00Z" }), [entry()], NOW);
    const live = steps.find((s) => s.state === "active");
    assert.equal(live?.code, "RUNNING");
  });

  test("a future attempt counts down instead", () => {
    const steps = buildJourney(row(), [entry()], NOW);
    const w = steps.find((s) => s.code === "WAITING");
    assert.equal(w?.state, "waiting");
    assert.match(w?.detail ?? "", /Attempt 2 of 3, in 3h/);
  });

  test("paused and snoozed both stop the countdown", () => {
    assert.equal(
      buildJourney(row({ paused: true }), [entry()], NOW).find((s) => s.state === "waiting")?.code,
      "PAUSED",
    );
    assert.equal(
      buildJourney(row({ hold_until: "2026-09-05T09:00:00Z" }), [entry()], NOW)
        .find((s) => s.state === "waiting")?.code,
      "SNOOZED",
    );
  });

  test("an open case always ends on the payment it is waiting for", () => {
    const steps = buildJourney(row(), [entry()], NOW);
    assert.equal(steps.at(-1)?.code, "PENDING");
  });
});

describe("the merchant's own actions", () => {
  test("your click is reported as yours, not as a rule", () => {
    const steps = buildJourney(
      row({ status: "recovered", recovered_at: "2026-09-03T09:50:00Z" }),
      [entry({
        channel: null, outcome: "no_action", sent_at: null,
        admin_action: "mark_paid", source: "admin",
        rationale: "Marked as paid manually.",
      })],
      NOW,
    );
    const mine = steps.find((s) => s.code === "BY YOU");
    assert.equal(mine?.title, "You marked it as paid");
    assert.ok(!steps.some((s) => s.title === "A rule stopped it here"));
  });

  test("a case closed by hand does not put words in Razorpay's mouth", () => {
    const steps = buildJourney(
      row({ status: "recovered", recovered_at: "2026-09-03T09:50:00Z" }),
      [entry({ channel: null, outcome: "no_action", sent_at: null, admin_action: "mark_paid" })],
      NOW,
    );
    const end = steps.at(-1);
    assert.equal(end?.title, "Marked as paid");
    assert.match(end?.detail ?? "", /Closed by you/);
  });

  test("a case Razorpay confirmed still says so", () => {
    const steps = buildJourney(
      row({ status: "recovered", recovered_at: "2026-09-03T09:50:00Z" }), [entry()], NOW,
    );
    assert.equal(steps.at(-1)?.title, "They paid");
    assert.match(steps.at(-1)?.detail ?? "", /Razorpay confirmed/);
  });

  test("an unknown override still reads as something you did", () => {
    const steps = buildJourney(
      row(), [entry({ channel: null, outcome: "skipped", admin_action: "something_new" })], NOW,
    );
    assert.equal(steps.find((s) => s.code === "BY YOU")?.title, "You acted on this case");
  });
});

describe("how it ends", () => {
  test("recovered closes the strip and stops promising more attempts", () => {
    const steps = buildJourney(
      row({ status: "recovered", recovered_at: "2026-09-03T09:50:00Z" }), [entry()], NOW,
    );
    assert.equal(steps.at(-1)?.code, "RECOVERED");
    assert.ok(!steps.some((s) => s.code === "WAITING" || s.code === "PENDING"));
  });

  test("stopped says why, in words a merchant would use", () => {
    const steps = buildJourney(
      row({ status: "stopped", stop_reason: "max_attempts_reached" }), [entry()], NOW,
    );
    assert.equal(steps.at(-1)?.detail, "Reached your attempt limit");
  });

  test("the control arm explains itself rather than looking like a failure", () => {
    const steps = buildJourney(
      row({ status: "stopped", stop_reason: "holdout_control" }), [], NOW,
    );
    assert.match(steps.at(-1)?.detail ?? "", /Held back on purpose/);
  });

  test("needs_human is waiting on a person, not stopped", () => {
    const steps = buildJourney(
      row({ status: "needs_human", stop_reason: "risk_flagged" }), [entry()], NOW,
    );
    assert.equal(steps.at(-1)?.code, "ESCALATED");
    assert.equal(steps.at(-1)?.state, "waiting");
  });

  test("an unrecognised stop reason still produces a sentence", () => {
    const steps = buildJourney(
      row({ status: "stopped", stop_reason: "something_new" }), [], NOW,
    );
    assert.equal(steps.at(-1)?.detail, "Chasing ended");
  });
});

describe("counting down", () => {
  test("minutes, hours and days", () => {
    assert.equal(countdown("2026-09-03T10:30:00Z", NOW), "in 30m");
    assert.equal(countdown("2026-09-03T15:00:00Z", NOW), "in 5h");
    assert.equal(countdown("2026-09-06T10:00:00Z", NOW), "in 3d");
  });

  test("a time already passed is due now, never negative", () => {
    assert.equal(countdown("2026-09-03T09:00:00Z", NOW), "due now");
  });
});

describe("progress", () => {
  test("counts only the steps actually finished", () => {
    const steps = buildJourney(row(), [entry()], NOW);
    const { done, total } = journeyProgress(steps);
    assert.equal(total, steps.length);
    assert.ok(done > 0 && done < total);
  });
});
