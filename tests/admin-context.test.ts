import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { splitHistory } from "../src/lib/agent/admin-chat";
import { ADMIN_ASK_PREFIX, ADMIN_REPLY_PREFIX, type TimelineEntry } from "../src/lib/board";

function entry(over: Partial<TimelineEntry>): TimelineEntry {
  return {
    id: Math.random().toString(36).slice(2),
    created_at: "2026-09-01T10:00:00Z",
    sent_at: null,
    channel: null,
    outcome: "no_action",
    message: null,
    intervention: null,
    rationale: null,
    guardrail: null,
    in_window: null,
    admin_action: null,
    source: null,
    response: null,
    ...over,
  };
}

describe("the context the agent is given", () => {
  test("keeps the admin conversation apart from what happened to the customer", () => {
    const { events, conversation } = splitHistory([
      entry({ channel: "email", outcome: "sent", message: "Hi Asha, your payment failed." }),
      entry({ message: `${ADMIN_ASK_PREFIX}why did this stop?` }),
      entry({ message: `${ADMIN_REPLY_PREFIX}They failed three times.` }),
    ]);

    assert.ok(events.includes("Hi Asha"), "the send belongs to the case history");
    assert.ok(!events.includes("why did this stop"), "the chat is not a case event");
    assert.ok(conversation.includes("admin: why did this stop?"));
    assert.ok(conversation.includes("you: They failed three times."));
  });

  test("does not truncate a long message", () => {
    // The old prompt cut every line at 160 characters, so the agent was
    // reasoning about copy it could only see the opening of.
    const long = "x".repeat(400);
    const { events } = splitHistory([
      entry({ channel: "whatsapp", outcome: "sent", message: long }),
    ]);
    assert.ok(events.includes(long), "the whole message reaches the model");
  });

  test("keeps every turn of a long conversation, not the last eight rows", () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      entry({ message: `${ADMIN_ASK_PREFIX}question ${i}` }),
    );
    const { conversation } = splitHistory(rows);
    assert.ok(conversation.includes("question 0"), "the first question survives");
    assert.ok(conversation.includes("question 29"), "and so does the most recent");
  });

  test("drops the oldest first if a case ever outgrows the budget", () => {
    const rows = Array.from({ length: 400 }, (_, i) =>
      entry({ channel: "email", outcome: "sent", message: `${i}:${"y".repeat(300)}` }),
    );
    const { events } = splitHistory(rows);
    assert.ok(events.includes("earlier entries omitted"), "it says what it dropped");
    assert.ok(events.includes("399:"), "the most recent is always kept");
  });
});
