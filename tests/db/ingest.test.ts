/**
 * Webhook ingestion: idempotency and customer resolution under concurrency.
 * Use case 16 lives here.
 */
import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Pool } from "pg";

const DB_URL =
  process.env.TEST_DB_URL ?? "postgres://postgres:tally@localhost:55432/tally";

let pool: Pool;
let merchantA: string;
let merchantB: string;

before(async () => {
  pool = new Pool({ connectionString: DB_URL, max: 12 });
  await pool.query(
    readFileSync(new URL("../../supabase/schema.sql", import.meta.url), "utf8"),
  );
});
after(async () => {
  await pool.end();
});

async function seedMerchant(name: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into merchants (business_name, razorpay_key_id, razorpay_key_secret, webhook_secret)
     values ($1,'enc:x','enc:y','whsec') returning id`,
    [name],
  );
  return rows[0].id;
}

beforeEach(async () => {
  await pool.query("truncate merchants, customers, events, actions cascade");
  merchantA = await seedMerchant("Mandate");
  merchantB = await seedMerchant("Swaseekh");
});

function ingest(
  merchantId: string,
  providerEventId: string | null,
  overrides: Partial<{
    type: string;
    reason: string;
    amount: number;
    email: string | null;
    phone: string | null;
    name: string | null;
  }> = {},
) {
  return pool.query<{ id: string; customer_id: string; status: string }>(
    `select * from ingest_event($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      merchantId,
      providerEventId,
      overrides.type ?? "payment_failed",
      overrides.reason ?? "insufficient_funds",
      overrides.amount ?? 250000,
      "INR",
      null,
      overrides.name ?? "Asha",
      overrides.email === undefined ? "asha@example.com" : overrides.email,
      overrides.phone === undefined ? null : overrides.phone,
      JSON.stringify({ order_id: "order_123" }),
    ],
  );
}

describe("ingest_event", () => {
  test("creates the event and the customer on first delivery", async () => {
    const { rows } = await ingest(merchantA, "evt_1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "queued");
    assert.ok(rows[0].customer_id, "customer should be resolved");

    const { rows: cust } = await pool.query("select * from customers");
    assert.equal(cust.length, 1);
  });

  test("a replayed webhook returns the same event and creates nothing new", async () => {
    const first = await ingest(merchantA, "evt_dup");
    const second = await ingest(merchantA, "evt_dup");

    assert.equal(
      second.rows[0].id,
      first.rows[0].id,
      "replay must return the original event, not a new one",
    );
    const { rows } = await pool.query<{ count: string }>(
      "select count(*)::text as count from events",
    );
    assert.equal(rows[0].count, "1");
  });

  test("concurrent duplicate deliveries create exactly one event and one customer", async () => {
    // Razorpay retries in parallel. This is the case that races.
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => ingest(merchantA, "evt_race")),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    assert.ok(ok.length >= 1, "at least one delivery must succeed");

    const { rows: events } = await pool.query<{ count: string }>(
      "select count(*)::text as count from events",
    );
    const { rows: customers } = await pool.query<{ count: string }>(
      "select count(*)::text as count from customers",
    );
    assert.equal(events[0].count, "1", "exactly one event survives the race");
    assert.equal(customers[0].count, "1", "exactly one customer survives the race");
  });

  test("the same customer across two events is one row, not two", async () => {
    await ingest(merchantA, "evt_a");
    await ingest(merchantA, "evt_b");
    const { rows } = await pool.query<{ count: string }>(
      "select count(*)::text as count from customers",
    );
    assert.equal(rows[0].count, "1");
  });

  test("a later event backfills a contact detail the first one lacked", async () => {
    // Card failure gives us an email; a UPI failure later gives us a phone.
    await ingest(merchantA, "evt_email", { email: "asha@example.com", phone: null });
    await ingest(merchantA, "evt_phone", {
      email: "asha@example.com",
      phone: "+919876543210",
    });
    const { rows } = await pool.query<{ email: string; phone: string }>(
      "select email, phone from customers",
    );
    assert.equal(rows.length, 1, "still one customer");
    assert.equal(rows[0].phone, "+919876543210", "phone should be filled in");
  });

  test("two merchants seeing the same person keep separate customer rows", async () => {
    await ingest(merchantA, "evt_a1");
    await ingest(merchantB, "evt_b1");
    const { rows } = await pool.query<{ merchant_id: string }>(
      "select merchant_id from customers",
    );
    assert.equal(rows.length, 2, "customer identity is per-merchant");
    assert.notEqual(rows[0].merchant_id, rows[1].merchant_id);
  });

  test("the same provider event id at two merchants does not collide", async () => {
    const a = await ingest(merchantA, "evt_shared");
    const b = await ingest(merchantB, "evt_shared");
    assert.notEqual(a.rows[0].id, b.rows[0].id);
  });

  test("events without a provider id are never deduped against each other", async () => {
    // Manually created events (a B2B invoice, a promise-to-pay) have no
    // provider event id. They must not collapse into one row.
    await ingest(merchantA, null, { type: "receivable_overdue" });
    await ingest(merchantA, null, { type: "receivable_overdue" });
    const { rows } = await pool.query<{ count: string }>(
      "select count(*)::text as count from events",
    );
    assert.equal(rows[0].count, "2");
  });

  test("an event with no contact details still records, with no customer", async () => {
    const { rows } = await ingest(merchantA, "evt_anon", {
      email: null,
      phone: null,
    });
    assert.equal(rows[0].customer_id, null);
    const { rows: cust } = await pool.query("select * from customers");
    assert.equal(cust.length, 0);
  });
});
