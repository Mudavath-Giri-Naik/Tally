/**
 * The numbered menu and the scripted turns around it.
 *
 * These are the paths where a wrong answer is expensive: "2" meaning stop has
 * to mean stop every time, and a menu number must never be read against a menu
 * that is no longer on screen.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderMenu, resolveChoice, isGreeting, MENUS } from "../src/lib/menu";
import {
  decideMove,
  situationLine,
  PROMPT_ROOT_MENU,
  PROMPT_OPTIONS_MENU,
  PROMPT_AWAITING_DATE,
} from "../src/lib/agent/dialogue";
import { classifyReply } from "../src/lib/inbound";
import { makeMerchant, makeCustomer, makeEvent } from "./helpers/context";

const merchant = makeMerchant({ business_name: "Mandate", timezone: "Asia/Kolkata" });
const customer = makeCustomer({ name: "Giri", phone: "+919812345678" });
const NOW = new Date("2026-09-01T06:00:00Z"); // 11:30 IST

function move(body: string, pending: string | null, events = [makeEvent({ amount: 149900 })]) {
  return decideMove({
    merchant,
    customer,
    events,
    body,
    intent: classifyReply(body, NOW, merchant.timezone),
    pending,
    now: NOW,
  });
}

describe("rendering", () => {
  test("numbers every option and leads with the real situation", () => {
    const text = renderMenu("root", situationLine(merchant, [makeEvent({ amount: 149900 })]));
    assert.match(text, /Mandate/);
    assert.match(text, /₹1,499/);
    assert.match(text, /1\. See my options/);
    assert.match(text, /2\. Stop these messages/);
  });

  test("says nothing is outstanding when nothing is", () => {
    const line = situationLine(merchant, [makeEvent({ status: "recovered" })]);
    assert.match(line, /nothing outstanding/i);
  });
});

describe("choosing an option", () => {
  test("accepts the bare number", () => {
    assert.equal(resolveChoice("root", "1")?.action, "show_options");
    assert.equal(resolveChoice("root", "2")?.action, "opt_out");
  });

  test("accepts what a phone keyboard adds around it", () => {
    for (const typed of ["1.", "1)", " 1 ", "1!"]) {
      assert.equal(resolveChoice("root", typed)?.action, "show_options", typed);
    }
  });

  test("accepts the words, since people answer lists in prose", () => {
    assert.equal(resolveChoice("root", "options")?.action, "show_options");
    assert.equal(resolveChoice("options", "pay later")?.action, "pay_later");
    assert.equal(resolveChoice("options", "ok send me the link please")?.action, "pay_now");
  });

  test("returns nothing for an answer that is not a choice", () => {
    assert.equal(resolveChoice("root", "why did my card fail"), null);
    assert.equal(resolveChoice("root", "9"), null);
  });

  test("every option is reachable and numbered in order", () => {
    for (const [id, options] of Object.entries(MENUS)) {
      options.forEach((o, i) => {
        assert.equal(o.key, String(i + 1), `${id} option ${i}`);
        assert.equal(resolveChoice(id as "root" | "options", o.key)?.action, o.action);
      });
    }
  });
});

describe("greetings", () => {
  test("a bare greeting opens the menu, with or without filler", () => {
    for (const g of ["hi", "Hii", "hello", "hey bro", "namaste ji", "Hi there"]) {
      assert.ok(isGreeting(g), g);
    }
  });

  test("a greeting with a real question in it is a question", () => {
    // Answering "hi why did my card fail" with a menu ignores the question.
    assert.ok(!isGreeting("hi why did my card fail"));
    assert.ok(!isGreeting("hello I already paid this"));
  });
});

describe("the next move", () => {
  test("a greeting shows the root menu and records what it asked", () => {
    const m = move("hi", null);
    assert.equal(m.kind, "say");
    if (m.kind === "say") {
      assert.match(m.text, /1\. See my options/);
      assert.equal(m.prompt, PROMPT_ROOT_MENU);
    }
  });

  test("choosing options shows them", () => {
    const m = move("1", PROMPT_ROOT_MENU);
    assert.equal(m.kind, "say");
    if (m.kind === "say") {
      assert.match(m.text, /I'll pay later/);
      assert.equal(m.prompt, PROMPT_OPTIONS_MENU);
    }
  });

  test("choosing stop opts out, from either menu", () => {
    assert.equal(move("2", PROMPT_ROOT_MENU).kind, "opt_out");
    assert.equal(move("5", PROMPT_OPTIONS_MENU).kind, "opt_out");
  });

  test("a number means nothing when no menu is on screen", () => {
    // The customer typing "2" out of the blue must not opt them out.
    assert.equal(move("2", null).kind, "converse");
    assert.equal(move("2", PROMPT_AWAITING_DATE).kind, "converse");
  });

  test("\"pay later\" asks which day, rather than guessing one", () => {
    const m = move("I want to pay later", null);
    assert.equal(m.kind, "say");
    if (m.kind === "say") {
      assert.match(m.text, /Which day/i);
      assert.equal(m.prompt, PROMPT_AWAITING_DATE);
    }
  });

  test("choosing 'pay later' from the menu asks the same question", () => {
    const m = move("2", PROMPT_OPTIONS_MENU);
    assert.equal(m.kind, "say");
    if (m.kind === "say") assert.equal(m.prompt, PROMPT_AWAITING_DATE);
  });

  test("a bare date answers that question and books the promise", () => {
    // "5 Sep" on its own is not a pay-intent - it only means anything as the
    // answer to the question just asked.
    const m = move("5 Sep", PROMPT_AWAITING_DATE);
    assert.equal(m.kind, "promise");
    if (m.kind === "promise") {
      assert.equal(m.dueDate, "2026-09-05");
      assert.match(m.text, /Sat|5 Sep/);
    }
  });

  test("tomorrow works as an answer too", () => {
    const m = move("tomorrow", PROMPT_AWAITING_DATE);
    assert.equal(m.kind, "promise");
    if (m.kind === "promise") assert.equal(m.dueDate, "2026-09-02");
  });

  test("a non-date answer hands over rather than asking twice", () => {
    // Asking "which day?" again after they said something else is a loop.
    assert.equal(move("why do you need that", PROMPT_AWAITING_DATE).kind, "converse");
  });

  test("a promise with a date needs no menu at all", () => {
    const m = move("I will pay on Friday", null);
    assert.equal(m.kind, "promise");
  });

  test("STOP wins wherever it arrives", () => {
    assert.equal(move("stop", null).kind, "opt_out");
    assert.equal(move("STOP", PROMPT_AWAITING_DATE).kind, "opt_out");
    assert.equal(move("please stop messaging me", PROMPT_OPTIONS_MENU).kind, "opt_out");
  });

  test("an open question still reaches the conversational agent", () => {
    assert.equal(move("why did my card fail", null).kind, "converse");
    assert.equal(move("is this link safe", PROMPT_ROOT_MENU).kind, "converse");
  });
});
