/**
 * Dashboard aggregation, against the real database.
 * Phase 3: the numbers a merchant watches must be correct and tenant-scoped.
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
  merchantStats,
  failureReasons,
  channelPerformance,
  auditTrail,
} from "../../src/lib/insights";

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

beforeEach(async () => {
  await pool.query("truncate merchants, customers, events, actions cascade");
  mandate = await seedMerchant("Mandate");
  swaseekh = await seedMerchant("Swaseekh");
});

async function seedEvent(
  merchantId: string,
  over: {
    status?: string;
    reason?: string;
    amount?: number;
    recovered?: number | null;
  } = {},
) {
  const { rows } = await pool.query<{ id: string }>(
    `insert into events (merchant_id, type, reason, amount, status, recovered_amount)
     values ($1,'payment_failed',$2,$3,$4,$5) returning id`,
    [
      merchantId,
      over.reason ?? "insufficient_funds",
      over.amount ?? 100000,
      over.status ?? "queued",
      over.recovered ?? null,
    ],
  );
  return rows[0].id;
}

describe("merchantStats", () => {
  test("counts and sums only the asking merchant's events", async () => {
    await seedEvent(mandate, { status: "recovered", amount: 500000 });
    await seedEvent(mandate, { status: "recovered", amount: 300000 });
    await seedEvent(mandate, { status: "queued", amount: 200000 });
    await seedEvent(mandate, { status: "stopped", amount: 100000 });
    // Another tenant's money must not appear anywhere in these figures.
    await seedEvent(swaseekh, { status: "recovered", amount: 9_999_999 });

    const stats = await merchantStats(mandate);
    assert.equal(stats.total_events, 4);
    assert.equal(stats.recovered, 2);
    assert.equal(stats.open, 1);
    assert.equal(stats.stopped, 1);
    assert.equal(stats.amount_recovered, 800000, "Rs 8,000 recovered");
    assert.equal(stats.amount_at_risk, 200000, "Rs 2,000 still open");
  });

  test("recovery rate excludes events not yet attempted", async () => {
    await seedEvent(mandate, { status: "recovered" });
    await seedEvent(mandate, { status: "stopped" });
    // A queued event has not had its chance yet - counting it as a miss would
    // make the rate look worse the faster events arrive.
    await seedEvent(mandate, { status: "queued" });

    const stats = await merchantStats(mandate);
    assert.equal(stats.recovery_rate, 50);
  });

  test("prefers the actual recovered amount when the provider gave one", async () => {
    await seedEvent(mandate, {
      status: "recovered",
      amount: 100000,
      recovered: 95000,
    });
    const stats = await merchantStats(mandate);
    assert.equal(stats.amount_recovered, 95000);
  });

  test("a merchant with no events gets zeros, not an error", async () => {
    const stats = await merchantStats(mandate);
    assert.equal(stats.total_events, 0);
    assert.equal(stats.recovery_rate, 0);
    assert.equal(stats.amount_recovered, 0);
  });
});

describe("failureReasons", () => {
  test("ranks causes and attaches the remedy for each", async () => {
    for (let i = 0; i < 3; i++) {
      await seedEvent(mandate, { reason: "insufficient_funds", amount: 100000 });
    }
    await seedEvent(mandate, { reason: "card_expired", amount: 50000 });
    await seedEvent(swaseekh, { reason: "gateway_timeout" });

    const reasons = await failureReasons(mandate);
    assert.equal(reasons.length, 2, "must not include the other tenant's causes");
    assert.equal(reasons[0].reason, "insufficient_funds");
    assert.equal(reasons[0].event_count, 3);
    assert.equal(reasons[0].amount_total, 300000);
    assert.equal(reasons[0].label, "Insufficient funds");
    assert.ok(
      reasons[0].remedy.length > 0,
      "a count without a remedy is trivia, not an insight",
    );
    assert.equal(reasons[1].reason, "card_expired");
  });
});

describe("channelPerformance", () => {
  test("reports sends and failures per channel", async () => {
    const eventId = await seedEvent(mandate, { status: "recovered" });
    for (const [channel, outcome] of [
      ["whatsapp", "sent"],
      ["whatsapp", "sent"],
      ["email", "sent"],
      ["email", "failed"],
    ] as const) {
      await pool.query(
        `insert into actions (event_id, merchant_id, channel, outcome)
         values ($1,$2,$3,$4)`,
        [eventId, mandate, channel, outcome],
      );
    }

    const perf = await channelPerformance(mandate);
    const wa = perf.find((p) => p.channel === "whatsapp")!;
    const em = perf.find((p) => p.channel === "email")!;
    assert.equal(wa.sent, 2);
    assert.equal(em.sent, 1);
    assert.equal(em.failed, 1);
  });
});

describe("auditTrail", () => {
  test("returns the reasoning alongside the action, newest first", async () => {
    const eventId = await seedEvent(mandate, { amount: 250000 });
    await pool.query(
      `insert into customers (id, merchant_id, name, email)
       values ('11111111-1111-4111-8111-111111111111',$1,'Asha','a@x.test')`,
      [mandate],
    );
    await pool.query(`update events set customer_id = '11111111-1111-4111-8111-111111111111'`);
    await pool.query(
      `insert into actions (event_id, merchant_id, channel, outcome, message, decision)
       values ($1,$2,'whatsapp','sent','Hi Asha',
               '{"rationale":"First nudge","root_cause":"insufficient_funds","intervention":"send_message"}'::jsonb)`,
      [eventId, mandate],
    );

    const rows = await auditTrail(mandate);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].channel, "whatsapp");
    assert.equal(rows[0].rationale, "First nudge");
    assert.equal(rows[0].root_cause, "insufficient_funds");
    assert.equal(rows[0].amount, 250000);
    assert.equal(rows[0].customer_name, "Asha");
  });

  test("never returns another merchant's actions", async () => {
    const theirs = await seedEvent(swaseekh);
    await pool.query(
      `insert into actions (event_id, merchant_id, channel, outcome)
       values ($1,$2,'email','sent')`,
      [theirs, swaseekh],
    );
    assert.deepEqual(await auditTrail(mandate), []);
    assert.equal((await auditTrail(swaseekh)).length, 1);
  });
});
