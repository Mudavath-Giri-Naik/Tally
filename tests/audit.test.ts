/**
 * The Audit Trail's own logic that needs no database: which outcome bucket a
 * filter name covers, and whether a send falls inside the contact window.
 *
 * The window check is inclusive of both ends, deliberately unlike
 * `withinContactWindow` in rules.ts (which decides whether to send *right
 * now*, and treats the closing minute as already past) - this one is judging
 * a send that already happened, and the merchant's own window is described as
 * running *through* the closing hour, not up to the instant before it.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { inContactWindow, isActionType, ACTION_TYPES } from "../src/lib/audit";
import type { Merchant } from "../src/lib/types";

function merchant(over: Partial<Merchant> = {}): Pick<
  Merchant,
  "timezone" | "contact_window_start" | "contact_window_end"
> {
  return {
    timezone: "Asia/Kolkata",
    contact_window_start: "08:00:00",
    contact_window_end: "19:00:00",
    ...over,
  };
}

// IST is UTC+5:30, fixed - no DST to worry about.
function ist(hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(2026, 5, 15, h - 5, m - 30));
}

describe("inContactWindow", () => {
  test("passes at the exact opening minute", () => {
    assert.equal(inContactWindow(ist("08:00"), merchant()), true);
  });

  test("passes at the exact closing minute", () => {
    // The window is described as running through 19:00, not stopping short
    // of it - a send stamped exactly on the hour must not read as a breach.
    assert.equal(inContactWindow(ist("19:00"), merchant()), true);
  });

  test("fails one minute before the window opens", () => {
    assert.equal(inContactWindow(ist("07:59"), merchant()), false);
  });

  test("fails one minute after the window closes", () => {
    assert.equal(inContactWindow(ist("19:01"), merchant()), false);
  });

  test("passes comfortably inside the window", () => {
    assert.equal(inContactWindow(ist("13:30"), merchant()), true);
  });

  test("fails well outside the window, at 3am", () => {
    assert.equal(inContactWindow(ist("03:00"), merchant()), false);
  });

  test("honours a merchant's own, narrower window", () => {
    const narrow = merchant({ contact_window_start: "10:00:00", contact_window_end: "12:00:00" });
    assert.equal(inContactWindow(ist("09:00"), narrow), false);
    assert.equal(inContactWindow(ist("11:00"), narrow), true);
  });

  test("a window that wraps past midnight is one window, not two", () => {
    const overnight = merchant({ contact_window_start: "22:00:00", contact_window_end: "06:00:00" });
    assert.equal(inContactWindow(ist("23:00"), overnight), true);
    assert.equal(inContactWindow(ist("02:00"), overnight), true);
    assert.equal(inContactWindow(ist("12:00"), overnight), false);
    // Both boundaries stay inclusive under the wrap too.
    assert.equal(inContactWindow(ist("22:00"), overnight), true);
    assert.equal(inContactWindow(ist("06:00"), overnight), true);
  });

  test("judges the merchant's own timezone, not the server's", () => {
    // 03:00 UTC is 08:30 IST - inside; reading it as UTC would fail it.
    const at = new Date("2026-06-15T03:00:00Z");
    assert.equal(inContactWindow(at, merchant()), true);
  });
});

describe("isActionType", () => {
  test("accepts exactly the four filter buckets", () => {
    for (const t of ACTION_TYPES) assert.equal(isActionType(t), true);
  });

  test("rejects anything else, including a raw outcome value", () => {
    assert.equal(isActionType("sent_ok"), false);
    assert.equal(isActionType("delivered"), false);
    assert.equal(isActionType(null), false);
    assert.equal(isActionType(undefined), false);
    assert.equal(isActionType(42), false);
  });
});
