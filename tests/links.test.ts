import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  stripInventedLinks,
  hasInventedLink,
  dropUnbackedLinkPromise,
  offersLink,
} from "../src/lib/agent/links";
import { explainFailure } from "../src/lib/agent/admin-chat";

const REAL = "https://rzp.io/i/AbCd1234";

describe("stripping links the model invented", () => {
  test("removes a fabricated payment URL", () => {
    // The exact shape that reached a real customer: plausible, branded, fake.
    const body = "Hi Asha, your payment did not go through. Retry here: https://tally.so/pay/retry";
    const out = stripInventedLinks(body, REAL);
    assert.ok(!out.includes("tally.so"), "the invented link must not survive");
    assert.ok(out.includes("Hi Asha"), "the rest of the message is kept");
  });

  test("keeps the link Razorpay actually issued", () => {
    const body = `Please complete your payment: ${REAL}`;
    assert.equal(stripInventedLinks(body, REAL), body);
  });

  test("keeps the real link even when the model adds a trailing slash", () => {
    // Dropping a customer's genuine payment link over a slash would be a
    // worse failure than the invention this guards against.
    const body = `Pay here: ${REAL}/`;
    assert.ok(stripInventedLinks(body, REAL).includes(REAL));
  });

  test("removes every URL when no link was issued for this attempt", () => {
    const body = "Update your card at https://example.com/billing please";
    const out = stripInventedLinks(body, null);
    assert.ok(!out.includes("http"), "nothing may be linked when nothing was issued");
    assert.ok(out.includes("Update your card"));
  });

  test("keeps sentence punctuation that followed the link", () => {
    const out = stripInventedLinks("Retry at https://fake.example/pay. Thanks!", null);
    assert.ok(out.endsWith("Thanks!"));
    assert.ok(!out.includes("fake.example"));
  });

  test("catches bare www links too", () => {
    assert.equal(hasInventedLink("go to www.tally.so/pay now", REAL), true);
  });

  test("a message with no links at all is untouched", () => {
    const body = "Your bank was unreachable. We will try again shortly.";
    assert.equal(stripInventedLinks(body, REAL), body);
    assert.equal(hasInventedLink(body, REAL), false);
  });

  test("does not leave the scaffolding a removed link sat in", () => {
    const out = stripInventedLinks("Complete it here:  https://fake.example/x", null);
    assert.ok(!out.endsWith(":"), `left a dangling colon: ${JSON.stringify(out)}`);
  });
});

describe("promising a link that was never attached", () => {
  test("drops the sentence when no link exists", () => {
    // This shipped to a real customer: link creation was failing, the copy
    // still said "the link below", and nothing was appended.
    const body =
      "Hi Girish, we noticed you didn't get a chance to finish your order. " +
      "You can complete your payment securely using the link below. " +
      "We're here if you have any questions!";
    const out = dropUnbackedLinkPromise(body, null);
    assert.ok(!/link below/i.test(out), `still promises a link: ${out}`);
    assert.ok(out.includes("Hi Girish"), "the rest of the message survives");
    assert.ok(out.includes("any questions"), "and so does the closing line");
  });

  test("leaves the message alone when a link really is attached", () => {
    const body = "Complete your payment using the link below.";
    assert.equal(dropUnbackedLinkPromise(body, "https://rzp.io/i/AbCd"), body);
  });

  test("catches a follow-up referring back to a link that never arrived", () => {
    const out = dropUnbackedLinkPromise(
      "Please let me know once you complete the ₹1,999 payment using the link above. Thanks!",
      null,
    );
    assert.ok(!/link above/i.test(out));
    assert.ok(out.includes("Thanks!"));
  });

  test("says something true when the promise was the whole message", () => {
    const out = dropUnbackedLinkPromise("Please pay using the link below.", null);
    assert.ok(out.length > 0, "never sends an empty message");
    assert.ok(!/link below/i.test(out));
  });
});

describe("explaining a throttle to a person", () => {
  test("a per-minute limit says it clears itself, and when", () => {
    const raw =
      'Gemini 429: {"error":{"status":"RESOURCE_EXHAUSTED","details":[' +
      '{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier"},' +
      '{"retryDelay":"27s"}]}}';
    const out = explainFailure(raw);
    assert.match(out, /27 seconds/);
    assert.ok(!/daily/i.test(out), "a per-minute throttle is not a daily one");
  });

  test("a daily limit says so, because waiting will not help", () => {
    const raw =
      'Gemini 429: {"error":{"details":[{"quotaId":"GenerateRequestsPerDayPerProject-FreeTier"}]}}';
    assert.match(explainFailure(raw), /daily/i);
  });
});

/**
 * The signal that decides whether a real link gets minted at all.
 *
 * When this said no, every URL the agent wrote was stripped as an invention
 * and the customer received a message referring to a link that had been
 * deleted on the way out - while the dashboard, which recorded the draft,
 * showed the link present. That is what made it look like WhatsApp dropping
 * links rather than us removing them.
 */
describe("noticing that a reply is trying to give someone a link", () => {
  test("a written-out URL counts", () => {
    assert.equal(offersLink("You can pay here: https://rzp.io/i/AbCd1234"), true);
    assert.equal(offersLink("go to www.example.com to pay"), true);
  });

  test("a promise with no URL counts too, since it needs backing", () => {
    assert.equal(offersLink("Please complete it using the link below."), true);
    assert.equal(offersLink("Click the link to finish your payment."), true);
  });

  test("an ordinary reply does not", () => {
    assert.equal(offersLink("Which day can you complete the ₹4,499?"), false);
    assert.equal(offersLink("Thanks - I will check that and come back to you."), false);
  });

  test("the answer does not change when asked twice", () => {
    // URL_RE carries /g, and .test() on a global regex advances lastIndex -
    // so the same string would answer true, then false, then true again.
    const said = "Pay here: https://rzp.io/i/AbCd1234";
    assert.equal(offersLink(said), true);
    assert.equal(offersLink(said), true);
    assert.equal(offersLink(said), true);
  });
});
