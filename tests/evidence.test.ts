/**
 * The Evidence page's arithmetic and its honesty.
 *
 * Two things are being pinned here. The sums, obviously. But mostly the
 * refusals: a lift over four events must not present itself as a result, a
 * rule the database said nothing about must not render green, and a return on
 * zero spend must not be infinity. Every one of those is a way a page like
 * this could mislead a merchant while printing nothing false.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_CONTROL_EVENTS,
  buildInvariants,
  buildLift,
  hourInWindow,
  recoveryRate,
  returnOnSpend,
} from "../src/lib/evidence";

const arm = (a: string, events: number, recovered: number, extra = {}) => ({
  arm: a,
  events: String(events),
  recovered: String(recovered),
  amount_at_risk: "100000",
  amount_recovered: "50000",
  ...extra,
});

describe("recovery rate", () => {
  test("is a percentage to one decimal place", () => {
    assert.equal(recoveryRate(8, 2), 25);
    assert.equal(recoveryRate(3, 1), 33.3);
  });

  test("no events is zero, not a division by zero", () => {
    assert.equal(recoveryRate(0, 0), 0);
    assert.equal(Number.isFinite(recoveryRate(0, 0)), true);
  });
});

describe("the two arms", () => {
  test("computes the gap between them in points", () => {
    const lift = buildLift([arm("contacted", 100, 40), arm("control", 100, 12)]);
    assert.equal(lift.contacted.rate, 40);
    assert.equal(lift.control?.rate, 12);
    assert.equal(lift.points, 28);
  });

  test("no control arm means no lift claimed at all", () => {
    const lift = buildLift([arm("contacted", 50, 20)]);
    assert.equal(lift.control, null);
    assert.equal(lift.points, null);
    assert.equal(lift.significant, false);
  });

  test("a small control arm is reported, but never called significant", () => {
    const lift = buildLift([arm("contacted", 200, 80), arm("control", 4, 0)]);
    assert.equal(lift.points, 40);
    assert.equal(lift.significant, false);
  });

  test("significance turns on exactly at the threshold", () => {
    const below = buildLift([
      arm("contacted", 100, 40), arm("control", MIN_CONTROL_EVENTS - 1, 3),
    ]);
    const at = buildLift([
      arm("contacted", 100, 40), arm("control", MIN_CONTROL_EVENTS, 3),
    ]);
    assert.equal(below.significant, false);
    assert.equal(at.significant, true);
  });

  test("a negative lift is reported honestly, not floored at zero", () => {
    const lift = buildLift([arm("contacted", 100, 10), arm("control", 100, 25)]);
    assert.equal(lift.points, -15);
  });

  test("the gap does not arrive as floating-point noise", () => {
    const lift = buildLift([arm("contacted", 20, 3), arm("control", 20, 0)]);
    // 15 - 0, not 14.999999999999998.
    assert.equal(lift.points, 15);
  });

  test("empty data is an empty contacted arm, not a crash", () => {
    const lift = buildLift([]);
    assert.equal(lift.contacted.events, 0);
    assert.equal(lift.control, null);
  });
});

describe("return on spend", () => {
  test("is rupees back per rupee out", () => {
    assert.equal(returnOnSpend(100000, 1000), 100);
  });

  test("spending nothing is not an infinite return", () => {
    assert.equal(returnOnSpend(50000, 0), null);
  });
});

describe("the rules", () => {
  test("a rule with no breaches held", () => {
    const [first] = buildInvariants([{ rule: "opt_out_respected", breaches: "0" }]);
    assert.equal(first.id, "opt_out_respected");
    assert.equal(first.held, true);
  });

  test("a rule with breaches did not, and carries the count", () => {
    const inv = buildInvariants([{ rule: "contact_window", breaches: "3" }]);
    const w = inv.find((i) => i.id === "contact_window");
    assert.equal(w?.held, false);
    assert.equal(w?.breaches, 3);
  });

  test("a rule the database said nothing about is never shown as passing", () => {
    // Absent is absent. Rendering an unchecked rule green is the one lie this
    // page cannot afford.
    const inv = buildInvariants([]);
    assert.ok(inv.length > 0);
    assert.equal(inv.every((i) => i.held === false), true);
  });

  test("opt-out is listed first, because it is the one with a regulator", () => {
    assert.equal(buildInvariants([])[0].id, "opt_out_respected");
  });

  test("every rule states a claim and what a breach would mean", () => {
    for (const i of buildInvariants([])) {
      assert.ok(i.claim.length > 0, `${i.id} needs a claim`);
      assert.ok(i.breach.length > 0, `${i.id} needs a breach description`);
    }
  });
});

describe("shading an hour against the window", () => {
  test("an ordinary daytime window", () => {
    assert.equal(hourInWindow(8, "08:00", "19:00"), true);
    assert.equal(hourInWindow(18, "08:00", "19:00"), true);
    assert.equal(hourInWindow(7, "08:00", "19:00"), false);
  });

  test("a window that wraps past midnight is one window, not two", () => {
    assert.equal(hourInWindow(23, "22:00", "06:00"), true);
    assert.equal(hourInWindow(2, "22:00", "06:00"), true);
    assert.equal(hourInWindow(12, "22:00", "06:00"), false);
  });

  test("3am is outside an ordinary window - the case the chart exists to show", () => {
    assert.equal(hourInWindow(3, "09:00", "21:00"), false);
  });

  test("an all-day window shades all of it, closing hour included", () => {
    // The regression: an exclusive end dropped 23:00-23:59 out of a window
    // running to 23:59, so the chart announced violations the exact check had
    // just cleared. Two answers on one page is worse than either being wrong.
    for (let h = 0; h < 24; h++) {
      assert.equal(hourInWindow(h, "00:00", "23:59"), true, `hour ${h}`);
    }
  });

  test("the hour the window closes in still overlaps it", () => {
    assert.equal(hourInWindow(19, "08:00", "19:00"), true);
  });
});
