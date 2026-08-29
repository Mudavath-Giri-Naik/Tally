/**
 * Phase 1 "Done when": the worker claims events with no race condition even
 * when several workers run at once.
 *
 * These run against a real Postgres, not a mock - a mock cannot exhibit the
 * bug this is looking for. Bring one up with:
 *
 *   docker run -d --name tally-pg -e POSTGRES_PASSWORD=tally \
 *     -e POSTGRES_DB=tally -p 55432:5432 postgres:16-alpine
 *
 * then `npm run test:db`.
 */
import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Pool } from "pg";

const DB_URL =
  process.env.TEST_DB_URL ??
  "postgres://postgres:tally@localhost:55432/tally";

// Enough concurrency to actually interleave inside a single claim statement.
const WORKERS = 8;
const BATCH = 10;

let pool: Pool;
let merchantA: string;
let merchantB: string;

before(async () => {
  pool = new Pool({ connectionString: DB_URL, max: WORKERS + 4 });
  const schema = readFileSync(
    new URL("../../supabase/schema.sql", import.meta.url),
    "utf8",
  );
  await pool.query(schema);
});

after(async () => {
  await pool.end();
});

async function seedMerchant(name: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into merchants (business_name, razorpay_key_id, razorpay_key_secret, webhook_secret)
     values ($1, 'enc:x', 'enc:y', 'whsec') returning id`,
    [name],
  );
  return rows[0].id;
}

async function seedEvents(merchantId: string, n: number) {
  await pool.query(
    `insert into events (merchant_id, type, reason, amount, status)
     select $1, 'payment_failed', 'insufficient_funds', 50000, 'queued'
     from generate_series(1, $2)`,
    [merchantId, n],
  );
}

beforeEach(async () => {
  await pool.query("truncate merchants, customers, events, actions cascade");
  merchantA = await seedMerchant("Mandate");
  merchantB = await seedMerchant("Swaseekh");
});

describe("claim_events", () => {
  test("concurrent workers never claim the same event twice", async () => {
    const PER_MERCHANT = 100;
    await seedEvents(merchantA, PER_MERCHANT);
    await seedEvents(merchantB, PER_MERCHANT);
    const total = PER_MERCHANT * 2;

    // Every worker hammers claim_events at the same time until the queue
    // drains. If SKIP LOCKED or the EvalPlanQual recheck were wrong, the same
    // event id would come back to two different workers here.
    const claimedBy = new Map<string, string>();
    const duplicates: Array<{ id: string; first: string; second: string }> = [];

    let drained = false;
    while (!drained) {
      const results = await Promise.all(
        Array.from({ length: WORKERS }, (_, i) =>
          pool.query<{ id: string; claimed_by: string }>(
            "select id, claimed_by from claim_events($1, $2)",
            [`worker-${i}`, BATCH],
          ),
        ),
      );

      let gotAny = false;
      for (const res of results) {
        if (res.rows.length > 0) gotAny = true;
        for (const row of res.rows) {
          const prior = claimedBy.get(row.id);
          if (prior) {
            duplicates.push({ id: row.id, first: prior, second: row.claimed_by });
          } else {
            claimedBy.set(row.id, row.claimed_by);
          }
        }
      }
      drained = !gotAny;
    }

    assert.deepEqual(duplicates, [], "an event was claimed by two workers");
    assert.equal(
      claimedBy.size,
      total,
      `expected all ${total} events claimed exactly once, got ${claimedBy.size}`,
    );

    // And the database agrees: nothing left queued, nothing claimed twice.
    const { rows } = await pool.query<{ status: string; count: string }>(
      "select status, count(*)::text as count from events group by status",
    );
    assert.deepEqual(rows, [{ status: "processing", count: String(total) }]);
  });

  test("claiming is round-robin, so one busy merchant cannot starve another", async () => {
    // Merchant A floods the queue first; B's events arrive afterwards.
    await seedEvents(merchantA, 200);
    await new Promise((r) => setTimeout(r, 10)); // ensure later created_at
    await seedEvents(merchantB, 10);

    const { rows } = await pool.query<{ merchant_id: string }>(
      "select merchant_id from claim_events($1, $2)",
      ["fairness-probe", 20],
    );

    const fromB = rows.filter((r) => r.merchant_id === merchantB).length;
    // Strict FIFO would hand back 20 A-events and zero B-events, and B would
    // wait behind A's whole backlog. Round-robin must interleave them.
    assert.ok(
      fromB >= 9,
      `expected the second merchant's events to be interleaved, got ${fromB}/20 from B`,
    );
  });

  test("respects next_attempt_at - scheduled retries are not claimed early", async () => {
    await pool.query(
      `insert into events (merchant_id, type, status, next_attempt_at)
       values ($1, 'mandate_retry', 'queued', now() + interval '1 hour')`,
      [merchantA],
    );
    await pool.query(
      `insert into events (merchant_id, type, status, next_attempt_at)
       values ($1, 'mandate_retry', 'queued', now() - interval '1 minute')`,
      [merchantA],
    );

    const { rows } = await pool.query("select id from claim_events($1, $2)", [
      "scheduler",
      10,
    ]);
    assert.equal(rows.length, 1, "only the due retry should be claimed");
  });

  test("skips merchants that are paused", async () => {
    await seedEvents(merchantA, 5);
    await seedEvents(merchantB, 5);
    await pool.query("update merchants set active = false where id = $1", [
      merchantA,
    ]);

    const { rows } = await pool.query<{ merchant_id: string }>(
      "select merchant_id from claim_events($1, $2)",
      ["w", 50],
    );
    assert.equal(rows.length, 5);
    assert.ok(rows.every((r) => r.merchant_id === merchantB));
  });
});

describe("reclaim_stale_events", () => {
  test("requeues events abandoned by a dead worker, leaves live claims alone", async () => {
    await seedEvents(merchantA, 4);
    await pool.query("select id from claim_events($1, $2)", ["dead-worker", 4]);

    // Age two of the claims past the staleness threshold.
    await pool.query(
      `update events set claimed_at = now() - interval '20 minutes'
       where id in (select id from events limit 2)`,
    );

    const { rows } = await pool.query("select id from reclaim_stale_events($1)", [
      300,
    ]);
    assert.equal(rows.length, 2, "only the stale claims should be requeued");

    const { rows: counts } = await pool.query<{ status: string; count: string }>(
      "select status, count(*)::text as count from events group by status order by status",
    );
    assert.deepEqual(counts, [
      { status: "processing", count: "2" },
      { status: "queued", count: "2" },
    ]);
  });
});

describe("idempotency", () => {
  test("a duplicate webhook delivery cannot create a second event", async () => {
    const insert = () =>
      pool.query(
        `insert into events (merchant_id, type, provider_event_id)
         values ($1, 'payment_failed', 'evt_razorpay_123')
         on conflict (merchant_id, provider_event_id)
           where provider_event_id is not null
           do nothing
         returning id`,
        [merchantA],
      );

    const first = await insert();
    const second = await insert();

    assert.equal(first.rows.length, 1, "first delivery creates the event");
    assert.equal(second.rows.length, 0, "replay is a no-op");

    const { rows } = await pool.query<{ count: string }>(
      "select count(*)::text as count from events",
    );
    assert.equal(rows[0].count, "1");
  });

  test("the same provider event id at two merchants stays isolated", async () => {
    for (const m of [merchantA, merchantB]) {
      await pool.query(
        `insert into events (merchant_id, type, provider_event_id)
         values ($1, 'payment_failed', 'evt_shared_id')`,
        [m],
      );
    }
    const { rows } = await pool.query<{ count: string }>(
      "select count(*)::text as count from events",
    );
    assert.equal(rows[0].count, "2", "dedupe must be scoped per merchant");
  });
});
