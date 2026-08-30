/**
 * Phase 2 "Done when": every use case in Section 6 goes from event ->
 * decision -> message -> logged outcome.
 *
 * This runs the real worker against a real Postgres behind a real PostgREST,
 * with only two things faked: the model endpoint (so decisions are
 * deterministic) and the outbound transport (so nobody actually gets a
 * WhatsApp message at 3am during a test run). Everything between - claiming,
 * classification, guardrails, scheduling, the audit trail - is production code.
 *
 * Requires the local stack:  bash scripts/start-local-stack.sh
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";

const DB_URL =
  process.env.TEST_DB_URL ?? "postgres://postgres:tally@localhost:55432/tally";
const POSTGREST_PORT = Number(process.env.TEST_POSTGREST_PORT ?? 54331);
const SERVICE_JWT = process.env.TEST_SERVICE_JWT ?? "";

let pool: Pool;
let proxy: Server;
let anthropicStub: Server;

/** What the stubbed model returns next. */
let modelReply: Record<string, unknown> = {
  intervention: "send_message",
  channel: "whatsapp",
  subject: null,
  message: "Your payment did not go through. You can complete it here.",
  rationale: "First nudge.",
};
let promptsSeen: string[] = [];

/** Everything the worker tried to send, instead of sending it. */
interface SentMessage {
  channel: string;
  body: string;
  subject: string | null;
  link: string | null;
  to: { email: string | null; phone: string | null };
}
let sent: SentMessage[] = [];

before(async () => {
  pool = new Pool({ connectionString: DB_URL, max: 10 });

  // supabase-js addresses PostgREST under /rest/v1; a bare PostgREST serves at
  // the root. This strips the prefix so the real client library can be used
  // unmodified rather than stubbed out.
  proxy = createServer((req, res) => {
    const path = (req.url ?? "/").replace(/^\/rest\/v1/, "");
    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port: POSTGREST_PORT,
        path,
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${POSTGREST_PORT}` },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 500, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", (e) => {
      res.writeHead(502);
      res.end(String(e));
    });
    req.pipe(upstream);
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));

  anthropicStub = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        const body = JSON.parse(raw || "{}");
        const msg = body.messages?.[0]?.content;
        if (typeof msg === "string") promptsSeen.push(msg);
      } catch {
        /* ignore */
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_stub",
          type: "message",
          role: "assistant",
          model: "claude-opus-5",
          content: [{ type: "text", text: JSON.stringify(modelReply) }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 10 },
        }),
      );
    });
  });
  await new Promise<void>((r) => anthropicStub.listen(0, "127.0.0.1", r));

  process.env.SUPABASE_URL = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_JWT;
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  // Pin the backend explicitly: a TALLY_LLM_PROVIDER or GEMINI_API_KEY leaking
  // in from the developer's shell would otherwise send these tests at a real
  // model endpoint instead of the stub below.
  process.env.TALLY_LLM_PROVIDER = "anthropic";
  process.env.ANTHROPIC_API_KEY = "sk-ant-stub";
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(anthropicStub.address() as AddressInfo).port}`;
});

after(async () => {
  await pool.end();
  await new Promise<void>((r) => proxy.close(() => r()));
  await new Promise<void>((r) => anthropicStub.close(() => r()));
});

// Lazy singletons inside the app read the env set above on first use.
import { createMerchant } from "../../src/lib/merchants";
import { ingestEvent } from "../../src/lib/events";
import { runWorker, type WorkerTransport } from "../../src/lib/agent/worker";
import type { EventType, RootCause } from "../../src/lib/types";

const recordingTransport: WorkerTransport = {
  async dispatch(channel, msg) {
    sent.push({
      channel,
      body: msg.body,
      subject: msg.subject,
      link: msg.link,
      to: { email: msg.recipient.email, phone: msg.recipient.phone },
    });
    return { ok: true, providerId: `stub_${sent.length}` };
  },
  async createLink() {
    return "https://rzp.io/i/stubLink";
  },
};

let merchantId: string;

async function newMerchant(name: string, over: Record<string, unknown> = {}) {
  const { merchant } = await createMerchant({
    business_name: name,
    razorpay_key_id: "rzp_test_ABCDEF123456",
    razorpay_key_secret: "secret_value_here",
    channels_enabled: ["email", "whatsapp", "voice"],
    // A round-the-clock window by default, so these tests do not depend on
    // what time of day they are run. Without this the whole suite passes in
    // the afternoon and fails in the evening, because the contact-window
    // guardrail correctly defers every message outside 08:00-19:00 IST.
    // The window itself is covered by its own test below.
    contact_window_start: "00:00",
    contact_window_end: "23:59",
    ...over,
  });
  return merchant.id;
}

async function addEvent(opts: {
  merchantId?: string;
  type?: EventType;
  reason?: RootCause;
  amount?: number | null;
  email?: string | null;
  phone?: string | null;
  name?: string | null;
  providerEventId?: string | null;
}) {
  return ingestEvent({
    merchantId: opts.merchantId ?? merchantId,
    providerEventId: opts.providerEventId ?? `evt_${randomBytes(6).toString("hex")}`,
    type: opts.type ?? "payment_failed",
    reason: opts.reason ?? "insufficient_funds",
    amount: opts.amount === undefined ? 250000 : opts.amount,
    customerName: opts.name ?? "Asha",
    customerEmail: opts.email === undefined ? "asha@example.com" : opts.email,
    customerPhone: opts.phone === undefined ? "+919876543210" : opts.phone,
    metadata: {},
  });
}

async function auditFor(eventId: string) {
  const { rows } = await pool.query(
    `select channel, outcome, message, decision from actions
      where event_id = $1 order by created_at`,
    [eventId],
  );
  return rows as Array<{
    channel: string | null;
    outcome: string;
    message: string | null;
    decision: Record<string, unknown> | null;
  }>;
}

async function eventRow(eventId: string) {
  const { rows } = await pool.query(
    `select status, reason, attempts, stop_reason, next_attempt_at
       from events where id = $1`,
    [eventId],
  );
  return rows[0] as {
    status: string;
    reason: string;
    attempts: number;
    stop_reason: string | null;
    next_attempt_at: Date | null;
  };
}

beforeEach(async () => {
  await pool.query("truncate merchants, customers, events, actions cascade");
  sent = [];
  promptsSeen = [];
  modelReply = {
    intervention: "send_message",
    channel: "whatsapp",
    subject: null,
    message: "Your payment did not go through. You can complete it here.",
    rationale: "First nudge.",
  };
  merchantId = await newMerchant("Mandate");
});

/** Run one worker tick with the recording transport. */
function tick(batch = 20) {
  return runWorker({ batchSize: batch, transport: recordingTransport });
}

describe("use case 1 - degradation to root cause to a matched action", () => {
  test("classifies, decides, sends and logs the whole chain", async () => {
    const event = await addEvent({ reason: "otp_failed" });
    const report = await tick();

    assert.equal(report.claimed, 1);
    assert.equal(report.sent, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].channel, "whatsapp");
    assert.ok(sent[0].link, "a retry link should be attached");

    const audit = await auditFor(event.id);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].outcome, "sent");
    assert.equal(audit[0].decision?.root_cause, "otp_failed");
    assert.ok(audit[0].decision?.rationale, "the why must be recorded");
  });
});

describe("use cases 2-4, 7 - the non-card event types all flow", () => {
  for (const [label, type, reason] of [
    ["checkout drop-off", "cart_abandoned", "customer_abandoned"],
    ["failed subscription", "subscription_failed", "insufficient_funds"],
    ["B2B receivable", "receivable_overdue", "invoice_unpaid"],
    ["promise to pay", "promise_to_pay", "invoice_unpaid"],
  ] as const) {
    test(`${label} produces a message and an audit row`, async () => {
      const event = await addEvent({ type, reason });
      const report = await tick();

      assert.equal(report.claimed, 1, `${label} should be claimed`);
      assert.equal(sent.length, 1, `${label} should produce one message`);

      const audit = await auditFor(event.id);
      assert.equal(audit[0].outcome, "sent");
      assert.equal(audit[0].decision?.root_cause, reason);
    });
  }
});

describe("use case 5 - mandate retry sequencer", () => {
  test("a failed auto-debit is scheduled, not fired immediately", async () => {
    modelReply = {
      intervention: "schedule_retry",
      channel: "whatsapp",
      subject: null,
      message: "We will retry your auto-debit.",
      rationale: "Mandate retry.",
    };
    const event = await addEvent({ type: "mandate_retry", reason: "insufficient_funds" });
    const before = Date.now();
    const report = await tick();

    assert.equal(report.scheduled, 1);
    assert.equal(sent.length, 0, "a scheduled retry sends nothing now");

    const row = await eventRow(event.id);
    assert.equal(row.status, "queued");
    assert.ok(row.next_attempt_at, "must carry a scheduled time");
    const delayHours =
      (row.next_attempt_at!.getTime() - before) / 3_600_000;
    assert.ok(
      delayHours >= 23,
      `first mandate retry should wait ~24h, waited ${delayHours.toFixed(1)}h`,
    );
  });
});

describe("use case 6 - voice", () => {
  test("a voice decision reaches the voice channel", async () => {
    modelReply = {
      intervention: "send_message",
      channel: "voice",
      subject: null,
      message: "Namaste, aapka payment complete nahi hua.",
      rationale: "Voice is warmer for this customer.",
    };
    await addEvent({ reason: "gateway_timeout" });
    await tick();

    assert.equal(sent.length, 1);
    assert.equal(sent[0].channel, "voice");
  });
});

describe("use case 8 - insufficient funds is not retried instantly", () => {
  test("the retry is scheduled days out, near a salary date", async () => {
    modelReply = {
      intervention: "schedule_retry",
      channel: "whatsapp",
      subject: null,
      message: "No rush, complete it when you can.",
      rationale: "Wait for payday.",
    };
    const event = await addEvent({ reason: "insufficient_funds" });
    const before = Date.now();
    await tick();

    const row = await eventRow(event.id);
    const delayHours = (row.next_attempt_at!.getTime() - before) / 3_600_000;
    assert.ok(
      delayHours >= 48,
      `insufficient funds must wait at least 48h, waited ${delayHours.toFixed(1)}h`,
    );
  });
});

describe("use cases 9 and 12 - retries that cannot succeed are never scheduled", () => {
  for (const reason of [
    "card_expired",
    "card_blocked",
    "mandate_revoked",
    "international_declined",
  ] as const) {
    test(`${reason} is converted to a request for a new method`, async () => {
      // The model naively asks to retry. The guardrail must override it.
      modelReply = {
        intervention: "schedule_retry",
        channel: "email",
        subject: "Retrying",
        message: "We will try again shortly.",
        rationale: "Just retry it.",
      };
      const event = await addEvent({ reason });
      await tick();

      const audit = await auditFor(event.id);
      assert.equal(audit[0].decision?.intervention, "request_new_method");
      assert.equal(audit[0].decision?.source, "guardrail");
      assert.match(String(audit[0].decision?.guardrail), /not retryable/);
      assert.equal(sent.length, 1, "it should still contact the customer");
    });
  }
});

describe("use case 10 - a systemic failure does not blame the customer", () => {
  test("the agent is told the failure was not the customer's fault", async () => {
    await addEvent({ reason: "gateway_timeout" });
    await tick();

    assert.equal(promptsSeen.length, 1);
    assert.match(promptsSeen[0], /NOT the customer/);
    assert.match(promptsSeen[0], /systemic|infrastructure/i);
  });
});

describe("use case 11 - an OTP slip gets an immediate retry", () => {
  test("no artificial delay is imposed", async () => {
    const event = await addEvent({ reason: "otp_failed" });
    await tick();
    assert.equal(sent.length, 1, "should contact immediately, not schedule");
    const audit = await auditFor(event.id);
    assert.equal(audit[0].outcome, "sent");
  });
});

describe("use case 13 - one coordinated message, not two", () => {
  test("a customer with two open events is messaged once", async () => {
    const first = await addEvent({
      type: "subscription_failed",
      reason: "insufficient_funds",
      email: "dual@example.com",
    });
    const second = await addEvent({
      type: "cart_abandoned",
      reason: "customer_abandoned",
      email: "dual@example.com",
    });

    const report = await tick();

    assert.equal(report.claimed, 2, "both events are claimed");
    assert.equal(
      sent.length,
      1,
      `the customer must receive exactly one message, got ${sent.length}`,
    );

    // The one that was not sent should be explicitly suppressed, with a reason.
    const secondAudit = await auditFor(second.id);
    const firstAudit = await auditFor(first.id);
    const suppressed = [...firstAudit, ...secondAudit].find(
      (a) => a.decision?.guardrail === "coordinated_with_sibling_event",
    );
    assert.ok(suppressed, "the covered event must say why it was not sent");
    assert.equal(suppressed!.outcome, "skipped");

    // And the agent was told about the other open issue.
    assert.ok(
      promptsSeen.some((p) => /other open issues/.test(p)),
      "the prompt must mention the sibling event",
    );
  });
});

describe("use case 14 - repeat failures escalate to a human", () => {
  test("after enough cycles the agent stops nudging", async () => {
    // Three prior failures for the same customer.
    for (let i = 0; i < 3; i++) {
      await addEvent({ email: "repeat@example.com", reason: "insufficient_funds" });
    }
    await tick(); // clears the first batch
    sent = [];

    const fourth = await addEvent({
      email: "repeat@example.com",
      reason: "insufficient_funds",
    });
    const report = await tick();

    assert.equal(report.escalated, 1, "should escalate rather than message again");
    assert.equal(sent.length, 0, "nothing should be sent");

    const row = await eventRow(fourth.id);
    assert.equal(row.status, "stopped");
    assert.equal(row.stop_reason, "repeat_failure_across_cycles");
  });
});

describe("use case 15 - high-value failures escalate faster", () => {
  test("a large failure gets the voice channel when the model does not choose", async () => {
    modelReply = {
      intervention: "send_message",
      channel: null,
      subject: null,
      message: "Your payment could not be completed.",
      rationale: "Contact them.",
    };
    await addEvent({ amount: 9_000_00, reason: "gateway_timeout" });
    await tick();

    assert.equal(sent[0].channel, "voice");
    assert.ok(promptsSeen.some((p) => /HIGH-VALUE/.test(p)));
  });

  test("a small failure uses a cheaper channel", async () => {
    modelReply = {
      intervention: "send_message",
      channel: null,
      subject: null,
      message: "Your payment could not be completed.",
      rationale: "Contact them.",
    };
    await addEvent({ amount: 20000, reason: "gateway_timeout" });
    await tick();

    assert.equal(sent[0].channel, "whatsapp");
  });
});

describe("use case 16 - duplicate webhooks", () => {
  test("a replayed delivery never produces a second message", async () => {
    const a = await addEvent({ providerEventId: "evt_same" });
    const b = await addEvent({ providerEventId: "evt_same" });
    assert.equal(a.id, b.id, "replay returns the same event");

    const report = await tick();
    assert.equal(report.claimed, 1);
    assert.equal(sent.length, 1, "the customer is messaged once, not twice");
  });
});

describe("stopping rules", () => {
  test("an opted-out customer is never contacted", async () => {
    const event = await addEvent({ email: "optout@example.com" });
    await pool.query("update customers set opted_out = true");

    const report = await tick();
    assert.equal(report.stopped, 1);
    assert.equal(sent.length, 0, "nothing may be sent to someone who opted out");

    const row = await eventRow(event.id);
    assert.equal(row.status, "stopped");
    assert.equal(row.stop_reason, "customer_opted_out");

    const audit = await auditFor(event.id);
    assert.equal(audit[0].outcome, "no_action");
  });

  test("the attempt cap holds across repeated ticks", async () => {
    const capped = await newMerchant("Capped", { max_attempts: 2 });
    const event = await addEvent({ merchantId: capped, reason: "otp_failed" });

    // Drive the event past its cap, ignoring the scheduled delay each time.
    for (let i = 0; i < 5; i++) {
      await pool.query("update events set next_attempt_at = now() - interval '1 day'");
      await tick();
    }

    const row = await eventRow(event.id);
    assert.ok(row.attempts <= 2, `attempts must not exceed the cap, got ${row.attempts}`);
    assert.equal(row.status, "stopped");
    assert.equal(row.stop_reason, "max_attempts_reached");
    assert.ok(sent.length <= 2, `at most 2 messages, got ${sent.length}`);
  });

  test("a customer with no contact details is stopped, not crashed on", async () => {
    const event = await addEvent({ email: null, phone: null });
    const report = await tick();
    assert.equal(report.claimed, 1);
    assert.equal(sent.length, 0);
    const row = await eventRow(event.id);
    assert.equal(row.stop_reason, "no_contact_details");
  });
});

describe("workflows the merchant has switched off", () => {
  test("classifies the event but contacts nobody", async () => {
    // The whole point of gating after classification rather than before it:
    // a merchant who is not chasing abandoned checkouts should still be able
    // to see how many they had.
    const retailer = await newMerchant("NoCheckoutChasing", {
      workflows_enabled: ["failed_payment"],
    });
    const event = await addEvent({
      merchantId: retailer,
      type: "cart_abandoned",
      reason: "customer_abandoned",
    });

    const report = await tick();
    assert.equal(report.claimed, 1, "the event is still claimed and looked at");
    assert.equal(sent.length, 0, "nothing may be sent for a disabled workflow");

    const row = await eventRow(event.id);
    assert.equal(row.status, "stopped");
    assert.equal(row.stop_reason, "workflow_disabled");
    // Classification still happened and is still on the row.
    assert.equal(row.reason, "customer_abandoned");

    const audit = await auditFor(event.id);
    assert.equal(audit.length, 1, "the skip is itself an audit row");
    assert.equal(audit[0].outcome, "skipped");
    assert.equal(audit[0].decision?.guardrail, "workflow_disabled");
    assert.equal(audit[0].channel, null);
  });

  test("an enabled workflow on the same merchant still runs", async () => {
    const retailer = await newMerchant("OnlyFailedPayments", {
      workflows_enabled: ["failed_payment"],
    });
    const event = await addEvent({
      merchantId: retailer,
      type: "payment_failed",
      reason: "otp_failed",
    });

    await tick();
    assert.equal(sent.length, 1, "the enabled category is untouched by the gate");
    const audit = await auditFor(event.id);
    assert.equal(audit[0].outcome, "sent");
  });

  test("a promise to pay is honoured even with every workflow off", async () => {
    // A promise the customer made in conversation is not a category the
    // merchant opted into - dropping it would break a commitment they saw us
    // accept.
    const quiet = await newMerchant("NothingEnabled", {
      workflows_enabled: ["checkout_abandonment"],
    });
    const event = await addEvent({
      merchantId: quiet,
      type: "promise_to_pay",
      reason: "invoice_unpaid",
    });

    await tick();
    assert.equal(sent.length, 1, "a promise-to-pay follow-up must still go out");
    const audit = await auditFor(event.id);
    assert.equal(audit[0].outcome, "sent");
  });

  test("a revoked mandate is auto-pay, not a failed payment", async () => {
    // Razorpay reports it as payment.failed, so a merchant running only
    // failed-payment recovery would otherwise be chased about their
    // subscription churn - and one running only subscriptions would miss it.
    const subs = await newMerchant("SubsOnly", {
      workflows_enabled: ["subscription_autopay"],
    });
    const event = await addEvent({
      merchantId: subs,
      type: "payment_failed",
      reason: "mandate_revoked",
    });

    await tick();
    const row = await eventRow(event.id);
    assert.notEqual(
      row.stop_reason,
      "workflow_disabled",
      "a mandate failure belongs to the subscription workflow",
    );
  });
});

describe("the contact window", () => {
  test("defers a message that would land outside the merchant's hours", async () => {
    // A one-minute window that has certainly closed by now.
    const quiet = await newMerchant("QuietHours", {
      contact_window_start: "00:00",
      contact_window_end: "00:01",
    });
    const event = await addEvent({ merchantId: quiet, reason: "otp_failed" });

    const report = await tick();
    assert.equal(report.claimed, 1);
    assert.equal(sent.length, 0, "nothing may be sent outside the window");

    const audit = await auditFor(event.id);
    assert.match(String(audit[0].decision?.guardrail), /contact window/);

    const row = await eventRow(event.id);
    assert.equal(row.status, "queued", "it waits rather than being dropped");
    assert.ok(row.next_attempt_at, "and carries the time the window reopens");
  });
});

describe("multi-tenant isolation under concurrent load", () => {
  test("two merchants processed together never cross-contaminate", async () => {
    const swaseekh = await newMerchant("Swaseekh");

    for (let i = 0; i < 6; i++) {
      await addEvent({ merchantId, email: `m${i}@mandate.test`, reason: "otp_failed" });
      await addEvent({
        merchantId: swaseekh,
        email: `s${i}@swaseekh.test`,
        reason: "otp_failed",
      });
    }

    // Two workers racing over the same queue.
    const [r1, r2] = await Promise.all([tick(6), tick(6)]);
    assert.equal(r1.claimed + r2.claimed, 12, "every event claimed exactly once");

    // Each action is filed under the merchant that owns its event.
    const { rows } = await pool.query<{ mismatched: string }>(
      `select count(*)::text as mismatched
         from actions a join events e on e.id = a.event_id
        where a.merchant_id <> e.merchant_id`,
    );
    assert.equal(rows[0].mismatched, "0", "an action leaked across tenants");

    // No customer of one merchant was ever contacted for the other.
    const mandateRecipients = sent.filter((s) =>
      s.to.email?.endsWith("@mandate.test"),
    );
    const swaseekhRecipients = sent.filter((s) =>
      s.to.email?.endsWith("@swaseekh.test"),
    );
    assert.equal(
      mandateRecipients.length + swaseekhRecipients.length,
      sent.length,
      "every message went to a recognised tenant address",
    );

    const { rows: cust } = await pool.query<{ count: string }>(
      `select count(*)::text as count from customers c
         join merchants m on m.id = c.merchant_id
        where (c.email like '%@mandate.test' and m.business_name <> 'Mandate')
           or (c.email like '%@swaseekh.test' and m.business_name <> 'Swaseekh')`,
    );
    assert.equal(cust[0].count, "0", "a customer was filed under the wrong merchant");
  });
});

describe("audit trail completeness", () => {
  test("every processed event leaves at least one action row", async () => {
    await addEvent({ reason: "otp_failed", email: "a@x.test" });
    await addEvent({ reason: "card_expired", email: "b@x.test" });
    await addEvent({ email: null, phone: null, name: "Anon" });

    await tick();

    const { rows } = await pool.query<{ count: string }>(
      `select count(*)::text as count from events e
        where not exists (select 1 from actions a where a.event_id = e.id)`,
    );
    assert.equal(rows[0].count, "0", "an event was processed with no audit row");
  });

  test("every action records the reasoning behind it", async () => {
    await addEvent({ reason: "otp_failed" });
    await tick();

    const { rows } = await pool.query<{ count: string }>(
      `select count(*)::text as count from actions
        where decision is null
           or decision->>'rationale' is null
           or decision->>'root_cause' is null`,
    );
    assert.equal(rows[0].count, "0", "an action was logged without its reasoning");
  });
});
