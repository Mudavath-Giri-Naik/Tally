import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseAgentTurn,
  ADMIN_DID_MARKER,
  ADMIN_SENT_MARKER,
} from "../src/lib/board";

describe("reading a stored agent turn back", () => {
  test("a plain answer is just its reply", () => {
    const parsed = parseAgentTurn("It stopped because they failed three times.");
    assert.equal(parsed.reply, "It stopped because they failed three times.");
    assert.equal(parsed.action, null);
    assert.equal(parsed.sentBody, null);
  });

  test("carries back what was done and what was sent", () => {
    // The whole point of storing the receipt: after a refresh the panel must
    // still be able to show the message the customer actually received.
    const stored =
      "Sent it now." +
      `${ADMIN_DID_MARKER}send_whatsapp` +
      `${ADMIN_SENT_MARKER}Hi Asha, your payment did not go through.\n\nhttps://rzp.io/i/AbCd`;

    const parsed = parseAgentTurn(stored);
    assert.equal(parsed.reply, "Sent it now.");
    assert.equal(parsed.action, "send_whatsapp");
    assert.ok(parsed.sentBody?.startsWith("Hi Asha"));
    assert.ok(parsed.sentBody?.includes("rzp.io"), "the real link is kept");
  });

  test("an action with nothing sent still reports the action", () => {
    const parsed = parseAgentTurn(`Paused it.${ADMIN_DID_MARKER}pause_outreach`);
    assert.equal(parsed.reply, "Paused it.");
    assert.equal(parsed.action, "pause_outreach");
    assert.equal(parsed.sentBody, null);
  });

  test("a reply containing newlines is not mistaken for a marker", () => {
    const stored = "First line.\n\nSecond line.";
    const parsed = parseAgentTurn(stored);
    assert.equal(parsed.reply, stored, "only the markers split a turn");
    assert.equal(parsed.action, null);
  });

  test("a sent body containing its own blank lines survives intact", () => {
    const body = "Hi there.\n\nPay here:\n\nthanks";
    const parsed = parseAgentTurn(`Done.${ADMIN_SENT_MARKER}${body}`);
    assert.equal(parsed.sentBody, body);
    assert.equal(parsed.reply, "Done.");
  });
});
