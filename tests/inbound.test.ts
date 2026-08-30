import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  classifyReply,
  extractDueDate,
  stripChannelPrefix,
} from "../src/lib/inbound";

// A fixed Tuesday, so weekday arithmetic is checkable by hand.
// 2026-03-10T06:30:00Z = Tue 10 Mar 2026, 12:00 IST.
const NOW = new Date("2026-03-10T06:30:00Z");
const TZ = "Asia/Kolkata";

const reply = (s: string) => classifyReply(s, NOW, TZ);

describe("opt-out detection", () => {
  for (const word of [
    "STOP", "stop", "Stop", "STOPALL", "unsubscribe", "CANCEL", "END", "QUIT",
    "opt-out", "optout", "  stop  ", "STOP.",
  ]) {
    test(`treats ${JSON.stringify(word)} as an opt-out`, () => {
      assert.equal(reply(word).kind, "opt_out");
    });
  }

  for (const phrase of [
    "please stop messaging me",
    "dont message me again",
    "do not contact me",
    "remove me from your list",
    "no more messages please",
    "leave me alone",
    "I want to opt out",
    "message mat bhejo",
    "band karo ye messages",
    "mujhe nahi chahiye",
  ]) {
    test(`treats "${phrase}" as an opt-out`, () => {
      assert.equal(reply(phrase).kind, "opt_out", `failed on: ${phrase}`);
    });
  }

  test("opt-out wins even when a payment promise is in the same message", () => {
    // Honouring "stop" beats booking the follow-up.
    const r = reply("stop messaging me, I'll pay on Friday");
    assert.equal(r.kind, "opt_out");
  });

  test("does not fire on ordinary words containing a keyword", () => {
    // "stopped", "cancelled my card" - these are not opt-outs.
    assert.notEqual(reply("my card stopped working").kind, "opt_out");
    assert.notEqual(reply("the bank cancelled my card").kind, "opt_out");
    assert.notEqual(reply("I will end up paying tomorrow").kind, "opt_out");
  });
});

describe("promise-to-pay detection", () => {
  const cases: Array<[msg: string, expected: string]> = [
    ["I'll pay tomorrow", "2026-03-11"],
    ["will pay today", "2026-03-10"],
    ["I will pay on Friday", "2026-03-13"],
    ["paying on monday", "2026-03-16"],
    ["I'll pay day after tomorrow", "2026-03-12"],
    ["can pay in 3 days", "2026-03-13"],
    ["I will pay next week", "2026-03-17"],
    ["will pay on the 15th", "2026-03-15"],
    ["I'll pay on 20/03", "2026-03-20"],
    ["payment kar dunga kal", "2026-03-11"],
    ["paisa bhej dunga tomorrow", "2026-03-11"],
    ["I will pay after salary", "2026-04-01"],
  ];

  for (const [msg, expected] of cases) {
    test(`"${msg}" -> ${expected}`, () => {
      const r = reply(msg);
      assert.equal(r.kind, "promise_to_pay", `not detected: ${msg}`);
      if (r.kind === "promise_to_pay") assert.equal(r.dueDate, expected);
    });
  }

  test("a weekday that is today means next week, not today", () => {
    // NOW is a Tuesday. "I'll pay Tuesday" means the coming Tuesday.
    const r = reply("I'll pay on tuesday");
    assert.equal(r.kind, "promise_to_pay");
    if (r.kind === "promise_to_pay") assert.equal(r.dueDate, "2026-03-17");
  });

  test("an intent to pay with no date is NOT a trackable promise", () => {
    // Inventing a deadline the customer never gave would be worse than
    // asking for one. It is called out separately from "other" so the caller
    // can ask which day instead of escalating a perfectly answerable message.
    assert.equal(reply("I will pay").kind, "promise_no_date");
    assert.equal(reply("ok will pay soon").kind, "promise_no_date");
    // An intention stated without a modal verb still counts as one.
    assert.equal(reply("I want to pay later bro").kind, "promise_no_date");
    assert.equal(reply("I need to pay this").kind, "promise_no_date");
  });

  test("\"now\" is a date, not a missing one", () => {
    // Asking "which day?" of someone who just said they are paying now reads
    // as though nobody was listening.
    assert.equal(reply("Bro I will pay now").kind, "promise_to_pay");
  });

  test("a date with no intent to pay is not a promise either", () => {
    assert.equal(reply("I am travelling on Friday").kind, "other");
  });
});

describe("already-paid claims", () => {
  for (const msg of [
    "I already paid",
    "already paid this",
    "payment is done",
    "I have paid yesterday",
    "payment kar diya hai",
  ]) {
    test(`"${msg}" is flagged for a human, not treated as a promise`, () => {
      assert.equal(reply(msg).kind, "already_paid", `failed on: ${msg}`);
    });
  }
});

describe("everything else", () => {
  for (const msg of ["hi", "what is this", "who are you?", "??", ""]) {
    test(`"${msg}" is left for a human`, () => {
      assert.equal(reply(msg).kind, "other");
    });
  }
});

describe("extractDueDate", () => {
  test("resolves relative to the merchant's timezone, not the server's", () => {
    // 19:00 UTC on the 10th is already the 11th in Kolkata (00:30).
    const lateUtc = new Date("2026-03-10T19:00:00Z");
    assert.equal(extractDueDate("tomorrow", lateUtc, "Asia/Kolkata"), "2026-03-12");
    assert.equal(extractDueDate("tomorrow", lateUtc, "UTC"), "2026-03-11");
  });

  test("rolls a past day-of-month into next month", () => {
    // The 5th has passed on the 10th, so "on the 5th" means next month.
    assert.equal(extractDueDate("on the 5th", NOW, TZ), "2026-04-05");
  });

  test("month end resolves to the last day of the month", () => {
    assert.equal(extractDueDate("at month end", NOW, TZ), "2026-03-31");
  });

  test("returns null when no date is mentioned", () => {
    assert.equal(extractDueDate("i will pay", NOW, TZ), null);
  });

  test("ignores absurd day counts rather than scheduling years out", () => {
    assert.equal(extractDueDate("in 999 days", NOW, TZ), null);
  });
});

describe("stripChannelPrefix", () => {
  test("removes Twilio channel prefixes", () => {
    assert.equal(stripChannelPrefix("whatsapp:+919876543210"), "+919876543210");
    assert.equal(stripChannelPrefix("sms:+919876543210"), "+919876543210");
    assert.equal(stripChannelPrefix("+919876543210"), "+919876543210");
  });
});
