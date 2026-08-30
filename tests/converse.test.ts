/**
 * The conversational agent.
 *
 * The prompt itself is not testable by assertion - what is testable is that
 * the facts reaching the model are the real ones, and that the two hard limits
 * hold before any model call is made.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildConversePrompt,
  buildSummaryPrompt,
  dailyReplyCap,
  DEFAULT_DAILY_REPLY_CAP,
  INBOUND_PREFIX,
  REPLY_PREFIX,
  SUMMARY_PREFIX,
  FALLBACK_MESSAGE,
  MAX_TURNS_IN_CONTEXT,
  type ConversationContext,
} from "../src/lib/agent/converse";
import { makeMerchant, makeEvent, makeCustomer } from "./helpers/context";

function ctx(over: Partial<ConversationContext> = {}): ConversationContext {
  return {
    merchant: makeMerchant({ business_name: "Mandate" }),
    customer: makeCustomer({ name: "Asha", phone: "+919812345678" }),
    events: [],
    turns: [],
    ...over,
  };
}

describe("the conversation prompt", () => {
  test("states the amount and the real cause, so it need not be guessed", () => {
    const prompt = buildConversePrompt(
      ctx({
        events: [
          makeEvent({ amount: 149900, reason: "card_expired", status: "queued" }),
        ],
      }),
    );
    assert.match(prompt, /1,499/);
    assert.match(prompt, /card_expired/);
    // The remedy matters more than the label: it is what the customer is told.
    assert.match(prompt, /different card or UPI/i);
  });

  test("says plainly whether each payment is settled", () => {
    const unpaid = buildConversePrompt(
      ctx({ events: [makeEvent({ status: "queued", amount: 100000 })] }),
    );
    assert.match(unpaid, /is NOT paid/);

    const paid = buildConversePrompt(
      ctx({
        events: [
          makeEvent({ status: "recovered", amount: 100000, recovered_amount: 100000 }),
        ],
      }),
    );
    assert.match(paid, /IS paid/);
  });

  test("tells the model to invent nothing when there is no history", () => {
    const prompt = buildConversePrompt(ctx({ events: [] }));
    assert.match(prompt, /No payment records\. Do not invent any\./);
  });

  test("labels who said what, so the model can see whose turn it is", () => {
    const prompt = buildConversePrompt(
      ctx({
        turns: [
          { at: "2026-01-01T10:00:00Z", who: "business", text: "Your card expired." },
          { at: "2026-01-01T10:01:00Z", who: "customer", text: "which card?" },
        ],
      }),
    );
    assert.match(prompt, /YOU: Your card expired\./);
    assert.match(prompt, /CUSTOMER: which card\?/);
    // Ordering is the whole point of a transcript.
    assert.ok(
      prompt.indexOf("YOU: Your card expired.") <
        prompt.indexOf("CUSTOMER: which card?"),
    );
  });

  test("does not leak the merchant's credentials into the brief", () => {
    const prompt = buildConversePrompt(
      ctx({
        merchant: makeMerchant({
          razorpay_key_id: "SECRET_KEY_ID",
          razorpay_key_secret: "SECRET_KEY_SECRET",
          webhook_secret: "SECRET_WEBHOOK",
        }),
      }),
    );
    for (const secret of ["SECRET_KEY_ID", "SECRET_KEY_SECRET", "SECRET_WEBHOOK"]) {
      assert.ok(!prompt.includes(secret), `${secret} reached the prompt`);
    }
  });
});

describe("the summary prompt", () => {
  test("carries the transcript and names both sides", () => {
    const prompt = buildSummaryPrompt(
      ctx({
        turns: [
          { at: "2026-01-01T10:00:00Z", who: "customer", text: "already paid this" },
          { at: "2026-01-01T10:01:00Z", who: "business", text: "we will check" },
        ],
      }),
    );
    assert.match(prompt, /Mandate/);
    assert.match(prompt, /CUSTOMER: already paid this/);
    assert.match(prompt, /BUSINESS: we will check/);
  });
});

describe("the reply cap", () => {
  const original = process.env.TALLY_MAX_AUTO_REPLIES_PER_DAY;
  const restore = () => {
    if (original === undefined) delete process.env.TALLY_MAX_AUTO_REPLIES_PER_DAY;
    else process.env.TALLY_MAX_AUTO_REPLIES_PER_DAY = original;
  };

  test("defaults when unset", () => {
    delete process.env.TALLY_MAX_AUTO_REPLIES_PER_DAY;
    assert.equal(dailyReplyCap(), DEFAULT_DAILY_REPLY_CAP);
    restore();
  });

  test("honours an explicit cap, including zero", () => {
    process.env.TALLY_MAX_AUTO_REPLIES_PER_DAY = "3";
    assert.equal(dailyReplyCap(), 3);
    // Zero is a real setting - it turns auto-reply off without a code change.
    process.env.TALLY_MAX_AUTO_REPLIES_PER_DAY = "0";
    assert.equal(dailyReplyCap(), 0);
    restore();
  });

  test("falls back rather than trusting a malformed value", () => {
    for (const bad of ["abc", "-1", "2.5", ""]) {
      process.env.TALLY_MAX_AUTO_REPLIES_PER_DAY = bad;
      assert.equal(dailyReplyCap(), DEFAULT_DAILY_REPLY_CAP, `for ${JSON.stringify(bad)}`);
    }
    restore();
  });
});

describe("the transcript prefixes", () => {
  test("are distinct, since the trail is parsed back by them", () => {
    const all = [INBOUND_PREFIX, REPLY_PREFIX, SUMMARY_PREFIX];
    assert.equal(new Set(all).size, 3);
    // No prefix may be a prefix of another, or startsWith() would misfile a row.
    for (const a of all) {
      for (const b of all) {
        if (a !== b) assert.ok(!a.startsWith(b), `${a} starts with ${b}`);
      }
    }
  });
});

describe("when the model cannot be reached", () => {
  test("the holding line is short, honest, and promises no outcome", () => {
    // It goes to a real customer, so it must not imply the question was
    // answered or commit the business to a timeframe it has not agreed.
    assert.ok(FALLBACK_MESSAGE.length < 120);
    assert.doesNotMatch(FALLBACK_MESSAGE, /\bAI\b|assistant|bot|error|sorry/i);
    assert.doesNotMatch(FALLBACK_MESSAGE, /\b(24 hours|tomorrow|today|within)\b/i);
  });

  test("the context window is bounded, or a long chat stops working", () => {
    // The failure this guards against is a conversation that replies fine at
    // three turns and silently stops at fifteen, because the prompt and the
    // reasoning both grow against a fixed output budget.
    assert.ok(MAX_TURNS_IN_CONTEXT > 0 && MAX_TURNS_IN_CONTEXT <= 20);
  });
});
