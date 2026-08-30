/**
 * The dashboard's own data layer, against the real database.
 *
 * The aggregations here are the ones a merchant reads to decide whether Tally
 * is working, so the things worth pinning down are: they are scoped to one
 * tenant, they tell the truth when there is nothing to report, and the slug
 * that addresses the whole dashboard is always present and always unique.
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

let pool: Pool;
let proxy: Server;

before(async () => {
  pool = new Pool({ connectionString: DB_URL, max: 8 });
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

  process.env.SUPABASE_URL = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.TEST_SERVICE_JWT ?? "";
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

after(async () => {
  await pool.end();
  await new Promise<void>((r) => proxy.close(() => r()));
});

import {
  dailySeries,
  customerRows,
  actionSummary,
  statsWithTrend,
} from "../../src/lib/insights";
import { listEventsFiltered } from "../../src/lib/events";
import { getMerchantBySlug, resolveMerchant } from "../../src/lib/merchants";
import { pendingPrompt } from "../../src/lib/agent/dialogue";

let mandate: string;
let swaseekh: string;

async function seedMerchant(name: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into merchants (business_name, razorpay_key_id, razorpay_key_secret, webhook_secret)
     values ($1,'enc','enc','w') returning id`,
    [name],
  );
  return rows[0].id;
}

async function seedCustomer(
  merchantId: string,
  over: { name?: string; email?: string; phone?: string; optedOut?: boolean } = {},
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into customers (merchant_id, name, email, phone, opted_out)
     values ($1,$2,$3,$4,$5) returning id`,
    [
      merchantId,
      over.name ?? "Asha",
      over.email ?? `${randomBytes(4).toString("hex")}@example.test`,
      over.phone ?? null,
      over.optedOut ?? false,
    ],
  );
  return rows[0].id;
}

async function seedEvent(
  merchantId: string,
  over: {
    customerId?: string | null;
    status?: string;
    reason?: string;
    type?: string;
    amount?: number;
    recovered?: number | null;
    createdAt?: string;
  } = {},
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into events
       (merchant_id, customer_id, type, reason, amount, status, recovered_amount, created_at)
     values ($1,$2,$3,$4,$5,$6,$7, coalesce($8::timestamptz, now())) returning id`,
    [
      merchantId,
      over.customerId ?? null,
      over.type ?? "payment_failed",
      over.reason ?? "insufficient_funds",
      over.amount ?? 100000,
      over.status ?? "queued",
      over.recovered ?? null,
      over.createdAt ?? null,
    ],
  );
  return rows[0].id;
}

beforeEach(async () => {
  await pool.query("truncate merchants, customers, events, actions cascade");
  mandate = await seedMerchant("Mandate");
  swaseekh = await seedMerchant("Swaseekh");
});

describe("the dashboard slug", () => {
  test("is assigned from the business name without the app asking", async () => {
    const id = await seedMerchant("Sharma Traders Pvt Ltd");
    const { rows } = await pool.query<{ slug: string }>(
      "select slug from merchants where id = $1",
      [id],
    );
    assert.equal(rows[0].slug, "sharma-traders-pvt-ltd");
  });

  test("suffixes rather than failing when two businesses share a name", async () => {
    // Onboarding must not reject the second Sharma Traders in India.
    await seedMerchant("Sharma Traders");
    await seedMerchant("Sharma  Traders!");
    const { rows } = await pool.query<{ slug: string }>(
      "select slug from merchants where slug like 'sharma-traders%' order by slug",
    );
    assert.deepEqual(
      rows.map((r) => r.slug),
      ["sharma-traders", "sharma-traders-2"],
    );
  });

  test("falls back to something addressable for a non-Latin name", async () => {
    const id = await seedMerchant("हिंदी नाम");
    const { rows } = await pool.query<{ slug: string }>(
      "select slug from merchants where id = $1",
      [id],
    );
    // Not a bare hyphen, and not empty - either would be an unroutable URL.
    assert.match(rows[0].slug, /^[a-z0-9][a-z0-9-]*$/);
  });

  test("resolves by slug and by the id older links still carry", async () => {
    const bySlug = await getMerchantBySlug("mandate");
    assert.equal(bySlug?.id, mandate);

    assert.equal((await resolveMerchant("mandate"))?.id, mandate);
    assert.equal((await resolveMerchant(mandate))?.id, mandate);
    assert.equal(await resolveMerchant("no-such-business"), null);
  });
});

describe("dailySeries", () => {
  test("returns a row for every day, including the quiet ones", async () => {
    await seedEvent(mandate, { status: "recovered", amount: 50000 });

    const series = await dailySeries(mandate, 14);
    assert.equal(series.length, 14, "a gap would misdraw the chart");
    // Today is last; only it has anything on it.
    assert.equal(series[series.length - 1].events, 1);
    assert.equal(series[0].events, 0);
    assert.equal(series[0].amount_recovered, 0);
  });

  test("splits each day into recovered and still-outstanding money", async () => {
    await seedEvent(mandate, { status: "recovered", amount: 80000 });
    await seedEvent(mandate, { status: "queued", amount: 20000 });

    const today = (await dailySeries(mandate, 3)).at(-1)!;
    assert.equal(today.amount_recovered, 80000);
    assert.equal(today.amount_at_risk, 20000);
  });

  test("never counts another merchant's day", async () => {
    await seedEvent(swaseekh, { status: "recovered", amount: 9_999_999 });
    const series = await dailySeries(mandate, 7);
    assert.equal(
      series.reduce((a, d) => a + d.amount_recovered, 0),
      0,
    );
  });
});

describe("customerRows", () => {
  test("folds each customer's history into one row", async () => {
    const asha = await seedCustomer(mandate, { name: "Asha" });
    await seedEvent(mandate, {
      customerId: asha,
      status: "recovered",
      amount: 60000,
      recovered: 55000,
    });
    await seedEvent(mandate, { customerId: asha, status: "queued", amount: 40000 });

    const [row] = await customerRows(mandate);
    assert.equal(row.name, "Asha");
    assert.equal(row.total_events, 2);
    assert.equal(row.recovered, 1);
    assert.equal(row.open_events, 1);
    assert.equal(row.amount_recovered, 55000, "the provider's figure wins");
    assert.equal(row.amount_at_risk, 40000);
  });

  test("includes a customer who has no events yet", async () => {
    await seedCustomer(mandate, { name: "Brand New" });
    const rows = await customerRows(mandate);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].total_events, 0);
    assert.equal(rows[0].last_event_at, null);
  });

  test("carries the opt-out flag, which changes what the agent may do", async () => {
    await seedCustomer(mandate, { name: "Quiet", optedOut: true });
    const [row] = await customerRows(mandate);
    assert.equal(row.opted_out, true);
  });

  test("never returns another merchant's customers", async () => {
    await seedCustomer(swaseekh, { name: "Theirs" });
    assert.deepEqual(await customerRows(mandate), []);
  });
});

describe("actionSummary", () => {
  test("counts this merchant's outcomes only", async () => {
    const event = await seedEvent(mandate);
    const theirs = await seedEvent(swaseekh);
    for (const [eventId, merchantId, outcome] of [
      [event, mandate, "sent"],
      [event, mandate, "sent"],
      [event, mandate, "escalated"],
      [theirs, swaseekh, "sent"],
    ] as const) {
      await pool.query(
        `insert into actions (event_id, merchant_id, outcome) values ($1,$2,$3)`,
        [eventId, merchantId, outcome],
      );
    }

    const summary = await actionSummary(mandate);
    assert.equal(summary.sent, 2);
    assert.equal(summary.escalated, 1);
    assert.equal(summary.delivered, undefined, "absent, not zero");
  });
});

describe("statsWithTrend", () => {
  test("compares the window against the one before it", async () => {
    // Both timestamps are explicit. Letting the "current" one default to the
    // database's now() makes this test depend on the host and the Postgres
    // container agreeing on the time - and they do not: the container here
    // runs a few hundred milliseconds ahead, which put the row fractionally
    // beyond the upper bound merchantStats computes from the Node clock, and
    // the test failed perhaps one run in five.
    await seedEvent(mandate, {
      status: "recovered",
      amount: 100000,
      createdAt: new Date(Date.now() - 40 * 86_400_000).toISOString(),
    });
    await seedEvent(mandate, {
      status: "recovered",
      amount: 200000,
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    });

    const stats = await statsWithTrend(mandate, 30);
    assert.equal(stats.amount_recovered, 200000);
    assert.equal(stats.previous.amount_recovered, 100000);
    assert.equal(stats.recovered_delta_pct, 100);
  });

  test("reports no comparison rather than inventing one from zero", async () => {
    await seedEvent(mandate, {
      status: "recovered",
      amount: 200000,
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    const stats = await statsWithTrend(mandate, 30);
    // The first ever recovery is not "+100%", it is the first one.
    assert.equal(stats.recovered_delta_pct, null);
    assert.equal(stats.rate_delta_points, null);
  });
});

describe("listEventsFiltered", () => {
  test("pages without lying about the total", async () => {
    for (let i = 0; i < 7; i++) await seedEvent(mandate);

    const first = await listEventsFiltered(mandate, { limit: 3 });
    assert.equal(first.rows.length, 3);
    assert.equal(first.total, 7, "the count is of the whole result, not the page");

    const last = await listEventsFiltered(mandate, { limit: 3, offset: 6 });
    assert.equal(last.rows.length, 1);
  });

  test("filters by status and by type", async () => {
    await seedEvent(mandate, { status: "recovered" });
    await seedEvent(mandate, { status: "queued" });
    await seedEvent(mandate, { status: "queued", type: "cart_abandoned" });

    assert.equal((await listEventsFiltered(mandate, { status: "recovered" })).total, 1);
    assert.equal((await listEventsFiltered(mandate, { status: "queued" })).total, 2);
    assert.equal(
      (await listEventsFiltered(mandate, { type: "cart_abandoned" })).total,
      1,
    );
  });

  test("searches the customer, and survives punctuation in the term", async () => {
    const asha = await seedCustomer(mandate, {
      name: "Asha, Ltd. (Mumbai)",
      email: "asha@example.test",
    });
    await seedEvent(mandate, { customerId: asha });
    await seedEvent(mandate, { customerId: await seedCustomer(mandate, { name: "Bimal" }) });

    assert.equal((await listEventsFiltered(mandate, { search: "asha" })).total, 1);
    assert.equal((await listEventsFiltered(mandate, { search: "ASHA" })).total, 1);
    // A comma is a PostgREST filter separator; unescaped it would either error
    // or quietly match the wrong rows.
    assert.equal((await listEventsFiltered(mandate, { search: "Asha, Ltd." })).total, 0);
    assert.equal(
      (await listEventsFiltered(mandate, { search: "asha@example.test" })).total,
      1,
    );
  });

  test("attaches the customer, so the table needs no second query", async () => {
    const asha = await seedCustomer(mandate, {
      name: "Asha",
      phone: "+919812345678",
      optedOut: true,
    });
    await seedEvent(mandate, { customerId: asha });

    const [row] = (await listEventsFiltered(mandate)).rows;
    assert.equal(row.customer_name, "Asha");
    assert.equal(row.customer_phone, "+919812345678");
    assert.equal(row.customer_opted_out, true);
  });

  test("never returns another merchant's events", async () => {
    await seedEvent(swaseekh);
    const page = await listEventsFiltered(mandate);
    assert.equal(page.total, 0);
    assert.deepEqual(page.rows, []);
  });
});

describe("pendingPrompt", () => {
  async function seedAction(
    merchantId: string,
    eventId: string,
    message: string,
    guardrail: string | null,
  ) {
    await pool.query(
      `insert into actions (event_id, merchant_id, channel, message, outcome, decision)
       values ($1,$2,'whatsapp',$3,'sent',$4)`,
      [
        eventId,
        merchantId,
        message,
        JSON.stringify({
          root_cause: "unknown",
          intervention: "send_message",
          channel: "whatsapp",
          rationale: "test",
          source: "schedule",
          ...(guardrail ? { guardrail } : {}),
        }),
      ],
    );
  }

  test("reports the question the agent last asked", async () => {
    const asha = await seedCustomer(mandate, { name: "Asha" });
    const event = await seedEvent(mandate, { customerId: asha });
    await seedAction(mandate, event, "[reply] 1. See my options", "menu_root");

    assert.equal(await pendingPrompt(asha), "menu_root");
  });

  test("reports nothing once the customer has spoken since", async () => {
    // This is the contract the webhook depends on, and the reason it must read
    // the pending prompt *before* recording the incoming message: recording it
    // first makes the inbound row the newest one, the menu stops looking
    // pending, and a menu choice falls through to the conversational agent.
    const asha = await seedCustomer(mandate, { name: "Asha" });
    const event = await seedEvent(mandate, { customerId: asha });
    await seedAction(mandate, event, "[reply] 1. See my options", "menu_root");
    await seedAction(mandate, event, "[inbound] 1", "reply_needs_human");

    assert.equal(await pendingPrompt(asha), null);
  });

  test("finds a menu in the message when the guardrail is used for something else", async () => {
    // The worker's first dunning message appends a menu, but its guardrail is
    // already explaining the recovery decision.
    const asha = await seedCustomer(mandate, { name: "Asha" });
    const event = await seedEvent(mandate, { customerId: asha });
    await seedAction(
      mandate,
      event,
      "Your payment failed.\n\nReply with a number:\n1. See my options\n2. Stop these messages",
      "card_expired is not retryable",
    );

    assert.equal(await pendingPrompt(asha), "menu_root");
  });

  test("reports nothing for a customer with no history", async () => {
    const asha = await seedCustomer(mandate, { name: "Asha" });
    assert.equal(await pendingPrompt(asha), null);
  });
});

describe("the recovery board", () => {
  async function seedVoiceAction(merchantId: string, eventId: string) {
    await pool.query(
      `insert into actions (event_id, merchant_id, channel, message, outcome, sent_at)
       values ($1,$2,'voice','called them','sent', now())`,
      [eventId, merchantId],
    );
  }

  test("derives each of the six statuses", async () => {
    const plain = await seedCustomer(mandate, { name: "Plain" });
    const quiet = await seedCustomer(mandate, { name: "Quiet", optedOut: true });

    await seedEvent(mandate, { customerId: plain, status: "recovered" });
    await seedEvent(mandate, { customerId: quiet, status: "queued" });
    await seedEvent(mandate, {
      customerId: plain, status: "stopped", reason: "risk_declined",
    });
    await pool.query(
      `update events set stop_reason = 'risk_flagged'
        where merchant_id = $1 and status = 'stopped'`, [mandate],
    );
    const voiced = await seedEvent(mandate, { customerId: plain, status: "queued" });
    await seedVoiceAction(mandate, voiced);
    const capped = await seedEvent(mandate, { customerId: plain, status: "unrecoverable" });
    await pool.query(
      `update events set stop_reason = 'max_attempts_reached' where id = $1`, [capped],
    );
    await seedEvent(mandate, { customerId: plain, status: "queued" });

    const { rows } = await pool.query<{ status: string }>(
      `select status from merchant_board($1)`, [mandate],
    );
    const seen = rows.map((r) => r.status).sort();
    assert.deepEqual(seen, [
      "chasing", "escalated_voice", "needs_human", "opted_out", "recovered", "stopped",
    ]);
  });

  test("an opted-out customer outranks whatever their event says", async () => {
    // They asked not to be contacted; that is the fact a merchant needs to see
    // first, whatever state the recovery happens to be in.
    const quiet = await seedCustomer(mandate, { name: "Quiet", optedOut: true });
    await seedEvent(mandate, { customerId: quiet, status: "queued" });
    const { rows } = await pool.query<{ status: string }>(
      `select status from merchant_board($1)`, [mandate],
    );
    assert.equal(rows[0].status, "opted_out");
  });

  test("but a recovered payment outranks even that", async () => {
    const quiet = await seedCustomer(mandate, { name: "Quiet", optedOut: true });
    await seedEvent(mandate, { customerId: quiet, status: "recovered" });
    const { rows } = await pool.query<{ status: string }>(
      `select status from merchant_board($1)`, [mandate],
    );
    assert.equal(rows[0].status, "recovered");
  });

  test("counts compliance only against messages actually sent", async () => {
    const asha = await seedCustomer(mandate, { name: "Asha" });
    const event = await seedEvent(mandate, { customerId: asha });
    // Mandate's window is the schema default, 08:00-19:00 Asia/Kolkata.
    // 06:00 UTC is 11:30 IST - inside. 20:00 UTC is 01:30 IST - outside.
    await pool.query(
      `insert into actions (event_id, merchant_id, channel, outcome, sent_at, message)
       values ($1,$2,'whatsapp','sent', date_trunc('day', now()) + interval '6 hours', 'in'),
              ($1,$2,'whatsapp','sent', date_trunc('day', now()) + interval '20 hours', 'out'),
              ($1,$2,null,'no_action', null, 'withheld')`,
      [event, mandate],
    );

    const { rows } = await pool.query<{ m: Record<string, number> }>(
      `select merchant_board_metrics($1) as m`, [mandate],
    );
    // The withheld action is neither compliant nor non-compliant, so it is
    // counted in neither figure.
    assert.equal(Number(rows[0].m.sent_total), 2);
    assert.equal(Number(rows[0].m.sent_in_window), 1);
  });

  test("averages recovery time over recovered events only", async () => {
    const asha = await seedCustomer(mandate, { name: "Asha" });
    const recovered = await seedEvent(mandate, { customerId: asha, status: "recovered" });
    await pool.query(
      `update events set created_at = now() - interval '10 minutes', updated_at = now()
        where id = $1`, [recovered],
    );
    await seedEvent(mandate, { customerId: asha, status: "queued" });

    const { rows } = await pool.query<{ m: Record<string, number> }>(
      `select merchant_board_metrics($1) as m`, [mandate],
    );
    const secs = Number(rows[0].m.avg_recovery_seconds);
    assert.ok(secs >= 590 && secs <= 610, `expected ~600s, got ${secs}`);
  });

  test("reports no average at all when nothing is recovered", async () => {
    // Zero would read as "recovered instantly", which is the opposite of true.
    await seedEvent(mandate, { status: "queued" });
    const { rows } = await pool.query<{ m: Record<string, unknown> }>(
      `select merchant_board_metrics($1) as m`, [mandate],
    );
    assert.equal(rows[0].m.avg_recovery_seconds, null);
  });

  test("never shows another merchant's rows", async () => {
    await seedEvent(swaseekh, { status: "queued" });
    const { rows } = await pool.query(`select * from merchant_board($1)`, [mandate]);
    assert.equal(rows.length, 0);
  });
});
