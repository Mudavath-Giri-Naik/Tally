/**
 * What an attempt costs, and when one is not worth making.
 *
 * The proportionality rule is the load-bearing part: it is the difference
 * between an agent that recovers money and one that spends a rupee twenty to
 * chase ninety paise while phoning someone about it. It lives in code rather
 * than in the prompt precisely so it can be asserted here.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  CHANNEL_COST_PAISE,
  VOICE_MIN_AMOUNT_PAISE,
  costOf,
  formatCost,
  voiceIsProportionate,
} from "../src/lib/costs";

describe("what an attempt costs", () => {
  test("prices every channel the agent can actually use", () => {
    assert.deepEqual(Object.keys(CHANNEL_COST_PAISE).sort(), [
      "email", "voice", "whatsapp",
    ]);
  });

  test("a decision that sent nothing costs nothing", () => {
    assert.equal(costOf(null), 0);
  });

  test("every channel costs something, so none reads as unmeasured", () => {
    for (const channel of ["email", "whatsapp", "voice"] as const) {
      assert.ok(costOf(channel) > 0, `${channel} should have a cost`);
    }
  });

  test("the ordering is the one the economics actually have", () => {
    assert.ok(costOf("email") < costOf("whatsapp"));
    assert.ok(costOf("whatsapp") < costOf("voice"));
  });

  test("formats small money with the paise still visible", () => {
    assert.equal(formatCost(120), "₹1.20");
    assert.equal(formatCost(3), "₹0.03");
    assert.equal(formatCost(0), "₹0.00");
  });
});

describe("whether a call is proportionate", () => {
  test("not for a small amount", () => {
    assert.equal(voiceIsProportionate(9900), false);
  });

  test("yes at the threshold, and above it", () => {
    assert.equal(voiceIsProportionate(VOICE_MIN_AMOUNT_PAISE), true);
    assert.equal(voiceIsProportionate(VOICE_MIN_AMOUNT_PAISE + 1), true);
  });

  test("no, one paise below it - the boundary is exact", () => {
    assert.equal(voiceIsProportionate(VOICE_MIN_AMOUNT_PAISE - 1), false);
  });

  test("an amount we do not know is not an amount worth calling about", () => {
    assert.equal(voiceIsProportionate(null), false);
  });

  test("zero is not a reason to phone anyone", () => {
    assert.equal(voiceIsProportionate(0), false);
  });

  test("the call costs a real fraction of the floor, which is why it exists", () => {
    // If the threshold ever drifts down far enough that a call is a large
    // share of what it recovers, the rule has stopped doing its job.
    assert.ok(costOf("voice") * 100 < VOICE_MIN_AMOUNT_PAISE);
  });
});
