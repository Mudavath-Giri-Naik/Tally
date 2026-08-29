import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { toSpeakable, buildTwiml } from "../src/lib/channels/voice";
import { sendEmail } from "../src/lib/channels/email";
import { sendWhatsApp } from "../src/lib/channels/whatsapp";
import { placeVoiceCall } from "../src/lib/channels/voice";
import type { OutboundMessage } from "../src/lib/channels";

const msg = (over: Partial<OutboundMessage> = {}): OutboundMessage => ({
  merchantName: "Mandate",
  recipient: { name: "Asha", email: "asha@example.com", phone: "+919876543210" },
  subject: "Your payment did not go through",
  body: "Hi Asha, your payment of Rs 2,500 did not go through.",
  link: null,
  ...over,
});

describe("voice: making copy speakable", () => {
  test("strips URLs, which are unusable read aloud", () => {
    const spoken = toSpeakable(
      "Complete it here: https://rzp.io/i/abc123 thanks",
      true,
    );
    assert.ok(!spoken.includes("http"), "a URL must never be spoken");
    assert.match(spoken, /WhatsApp and email/, "must say where the link is instead");
  });

  test("strips markdown that would be read out as punctuation", () => {
    const spoken = toSpeakable("**Important** _please_ pay `now`", false);
    assert.ok(!/[*_`]/.test(spoken), `markdown leaked into speech: ${spoken}`);
  });

  test("does not mention a link when there is not one", () => {
    const spoken = toSpeakable("Your payment did not go through.", false);
    assert.ok(!/WhatsApp and email/.test(spoken));
  });
});

describe("voice: TwiML", () => {
  test("produces valid TwiML with an Indian voice", () => {
    const xml = buildTwiml(msg());
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?><Response>/);
    assert.match(xml, /<\/Response>$/);
    assert.match(xml, /voice="Polly\.Aditi"/);
    assert.match(xml, /language="hi-IN"/);
    assert.match(xml, /on behalf of Mandate/);
  });

  test("escapes XML so a message cannot break out of the Say element", () => {
    // A merchant name or agent message containing markup must not be able to
    // inject TwiML verbs - that would let message copy control the phone call.
    const xml = buildTwiml(
      msg({
        body: 'Pay now </Say><Hangup/><Say>you have been scammed',
        merchantName: "A & B <Ltd>",
      }),
    );
    assert.ok(!xml.includes("<Hangup/>"), "injected TwiML verb was not escaped");
    // Any angle bracket surviving from the message body must be escaped.
    assert.match(xml, /&lt;\/Say/, "markup must be neutralised, not passed through");
    assert.match(xml, /A &amp; B &lt;Ltd&gt;/, "merchant name must be escaped too");
    // Exactly the two Say elements the template itself defines, no more.
    assert.equal((xml.match(/<Say /g) ?? []).length, 2);
    assert.equal((xml.match(/<\/Say>/g) ?? []).length, 2);
  });
});

describe("channels degrade cleanly when unconfigured", () => {
  const saved: Record<string, string | undefined> = {};
  const vars = [
    "RESEND_API_KEY",
    "RESEND_FROM_EMAIL",
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_PHONE_NUMBER",
    "TWILIO_WHATSAPP_NUMBER",
  ];
  for (const v of vars) {
    saved[v] = process.env[v];
    delete process.env[v];
  }

  test("email names the variables it needs instead of throwing", async () => {
    const r = await sendEmail(msg());
    assert.equal(r.ok, false);
    assert.equal(r.permanent, true);
    assert.match(r.error!, /RESEND_API_KEY/);
    assert.match(r.error!, /RESEND_FROM_EMAIL/);
  });

  test("whatsapp names the variables it needs", async () => {
    const r = await sendWhatsApp(msg());
    assert.equal(r.ok, false);
    assert.match(r.error!, /TWILIO_ACCOUNT_SID/);
  });

  test("voice names the variables it needs", async () => {
    const r = await placeVoiceCall(msg());
    assert.equal(r.ok, false);
    assert.match(r.error!, /TWILIO_PHONE_NUMBER/);
  });

  test("a missing recipient address is a permanent failure, not a retry", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.RESEND_FROM_EMAIL = "t@example.com";
    try {
      const r = await sendEmail(
        msg({ recipient: { name: null, email: null, phone: null } }),
      );
      assert.equal(r.ok, false);
      assert.equal(r.permanent, true, "retrying will never find an address");
    } finally {
      delete process.env.RESEND_API_KEY;
      delete process.env.RESEND_FROM_EMAIL;
    }
  });

  test("restores the environment", () => {
    for (const v of vars) {
      if (saved[v] !== undefined) process.env[v] = saved[v];
    }
    assert.ok(true);
  });
});
