/**
 * Phase 4 - the batch run.
 *
 * Generates a realistic mixed batch across every connected merchant, drives
 * the worker over it the way cron would, and then *verifies the guardrails
 * actually held* rather than assuming they did. The invariant checks at the
 * end are the point of this script: it is easy to send a lot of messages and
 * much harder to prove none of them broke a rule.
 *
 *   npm run batch -- --dry-run          record sends instead of making them
 *   npm run batch -- --per-merchant=12  batch size
 *   npm run batch                       real sends, real money, real people
 *
 * --dry-run substitutes the recording transport. Everything else - the
 * database, classification, the decision engine, the guardrails, scheduling -
 * is the production path.
 */
import { Client } from "pg";
import { listMerchants } from "../src/lib/merchants";
import { ingestEvent } from "../src/lib/events";
import { runWorker, liveTransport, type WorkerTransport } from "../src/lib/agent/worker";
import { withinContactWindow } from "../src/lib/agent/rules";
import { formatINR } from "../src/lib/types";
import type { EventType, RootCause, Merchant } from "../src/lib/types";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const PER_MERCHANT = Number(
  args.find((a) => a.startsWith("--per-merchant="))?.split("=")[1] ?? 10,
);

/** A spread of the failures a real week actually produces. */
const SCENARIOS: Array<{
  type: EventType;
  reason: RootCause;
  amount: number;
  weight: number;
}> = [
  { type: "payment_failed", reason: "insufficient_funds", amount: 149900, weight: 5 },
  { type: "payment_failed", reason: "card_expired", amount: 89900, weight: 2 },
  { type: "payment_failed", reason: "otp_failed", amount: 49900, weight: 4 },
  { type: "payment_failed", reason: "gateway_timeout", amount: 129900, weight: 3 },
  { type: "payment_failed", reason: "international_declined", amount: 249900, weight: 1 },
  { type: "payment_failed", reason: "card_blocked", amount: 99900, weight: 1 },
  { type: "payment_failed", reason: "risk_declined", amount: 199900, weight: 1 },
  { type: "subscription_failed", reason: "insufficient_funds", amount: 59900, weight: 3 },
  { type: "mandate_retry", reason: "insufficient_funds", amount: 79900, weight: 2 },
  { type: "cart_abandoned", reason: "customer_abandoned", amount: 349900, weight: 3 },
  { type: "receivable_overdue", reason: "invoice_unpaid", amount: 2500000, weight: 1 },
  { type: "promise_to_pay", reason: "invoice_unpaid", amount: 1200000, weight: 1 },
  { type: "payment_failed", reason: "insufficient_funds", amount: 1500000, weight: 1 }, // high value
];

const WEIGHTED = SCENARIOS.flatMap((s) => Array<typeof s>(s.weight).fill(s));

/** Stand-ins for the ten friends in the real batch. */
function testers(count: number) {
  const names = [
    "Asha", "Rahul", "Meera", "Vikram", "Priya",
    "Arjun", "Divya", "Karan", "Neha", "Sanjay",
  ];
  return Array.from({ length: count }, (_, i) => ({
    name: names[i % names.length],
    email: `${names[i % names.length].toLowerCase()}${i}@batch.test`,
    phone: `+9198765${String(43000 + i).padStart(5, "0")}`,
  }));
}

interface Sent {
  channel: string;
  at: Date;
  merchantId: string;
  to: string | null;
}
const recorded: Sent[] = [];
let currentMerchant = "";

const recordingTransport: WorkerTransport = {
  async dispatch(channel, msg) {
    recorded.push({
      channel,
      at: new Date(),
      merchantId: currentMerchant,
      to: msg.recipient.email ?? msg.recipient.phone,
    });
    return { ok: true, providerId: `dry_${recorded.length}` };
  },
  async createLink() {
    return "https://rzp.io/i/dryRunLink";
  },
};

async function main() {
  const merchants = await listMerchants();
  if (merchants.length === 0) {
    console.error("No merchants connected. Run `npm run seed` or use the UI first.");
    process.exit(1);
  }

  console.log(
    `\nBatch run - ${DRY_RUN ? "DRY RUN (no messages sent)" : "LIVE (real messages)"}`,
  );
  console.log(`Merchants: ${merchants.map((m) => m.business_name).join(", ")}`);
  console.log(`Events per merchant: ${PER_MERCHANT}\n`);

  if (!DRY_RUN) {
    console.log("This will contact real people. Ctrl-C within 5s to abort.");
    await new Promise((r) => setTimeout(r, 5000));
  }

  // ── seed ──
  const people = testers(10);
  let seeded = 0;
  for (const merchant of merchants) {
    for (let i = 0; i < PER_MERCHANT; i++) {
      const scenario = WEIGHTED[Math.floor(Math.random() * WEIGHTED.length)];
      const person = people[i % people.length];
      await ingestEvent({
        merchantId: merchant.id,
        providerEventId: `batch_${merchant.id.slice(0, 8)}_${Date.now()}_${i}`,
        type: scenario.type,
        reason: scenario.reason,
        amount: scenario.amount,
        customerName: person.name,
        // Scope the address to the merchant so cross-tenant leakage is visible.
        customerEmail: `${merchant.business_name.toLowerCase()}.${person.email}`,
        customerPhone: person.phone,
        metadata: { batch: true, scenario: scenario.reason },
      });
      seeded++;
    }
  }
  console.log(`Seeded ${seeded} events.\n`);

  // ── drive the workers ──
  const startedAt = new Date();
  const totals = { claimed: 0, sent: 0, scheduled: 0, stopped: 0, escalated: 0, failed: 0 };
  const transport = DRY_RUN ? recordingTransport : liveTransport;

  for (let round = 1; round <= 5; round++) {
    // Two workers, concurrently - the same contention production sees.
    const [a, b] = await Promise.all([
      runWorker({ workerId: `batch-a-${round}`, batchSize: 15, transport }),
      runWorker({ workerId: `batch-b-${round}`, batchSize: 15, transport }),
    ]);
    for (const r of [a, b]) {
      totals.claimed += r.claimed;
      totals.sent += r.sent;
      totals.scheduled += r.scheduled;
      totals.stopped += r.stopped;
      totals.escalated += r.escalated;
      totals.failed += r.failed;
      for (const e of r.errors) console.log(`  ! ${e.eventId}: ${e.error}`);
    }
    console.log(
      `Round ${round}: claimed=${a.claimed + b.claimed} sent=${a.sent + b.sent} ` +
        `scheduled=${a.scheduled + b.scheduled} stopped=${a.stopped + b.stopped} ` +
        `escalated=${a.escalated + b.escalated} failed=${a.failed + b.failed}`,
    );
    if (a.claimed + b.claimed === 0) break;
  }

  console.log("\n─── Batch totals ───");
  console.table(totals);

  await verify(merchants, startedAt);
}

/**
 * The part that matters: did the rules actually hold?
 *
 * Every check queries the database directly rather than trusting the worker's
 * own report, because the worker reporting a clean run is exactly what a bug
 * here would also look like.
 */
async function verify(merchants: Merchant[], since: Date) {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) {
    console.log(
      "\nSet SUPABASE_DB_URL to run the invariant checks (they query Postgres directly).",
    );
    return;
  }

  const pg = new Client({
    connectionString: url,
    ssl:
      url.includes("localhost") || url.includes("127.0.0.1")
        ? undefined
        : { rejectUnauthorized: false },
  });
  await pg.connect();

  const failures: string[] = [];
  const pass = (label: string, ok: boolean, detail = "") => {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`);
    if (!ok) failures.push(label);
  };

  console.log("\n─── Invariant checks ───");

  // 1. Attempt caps.
  const capped = await pg.query<{ count: string }>(
    `select count(*)::text as count from events e
       join merchants m on m.id = e.merchant_id
      where e.attempts > m.max_attempts`,
  );
  pass(
    "no event exceeded its merchant's attempt cap",
    capped.rows[0].count === "0",
    `${capped.rows[0].count} over cap`,
  );

  // 2. Opt-out is absolute.
  const optedOut = await pg.query<{ count: string }>(
    `select count(*)::text as count
       from actions a
       join events e on e.id = a.event_id
       join customers c on c.id = e.customer_id
      where c.opted_out and a.outcome in ('sent','delivered')`,
  );
  pass(
    "no opted-out customer was contacted",
    optedOut.rows[0].count === "0",
    `${optedOut.rows[0].count} contacted`,
  );

  // 3. Dead-end causes were never retried.
  const badRetries = await pg.query<{ count: string }>(
    `select count(*)::text as count from actions
      where decision->>'intervention' = 'schedule_retry'
        and decision->>'root_cause' in
            ('card_expired','card_blocked','mandate_revoked',
             'international_declined','risk_declined','mandate_limit_exceeded')`,
  );
  pass(
    "no retry was scheduled for a cause that cannot succeed",
    badRetries.rows[0].count === "0",
    `${badRetries.rows[0].count} bad retries`,
  );

  // 4. Risk-flagged payments went to a human.
  const riskAutomated = await pg.query<{ count: string }>(
    `select count(*)::text as count
       from actions a
      where a.decision->>'root_cause' = 'risk_declined'
        and a.outcome in ('sent','delivered')`,
  );
  pass(
    "risk-flagged payments were escalated, not messaged",
    riskAutomated.rows[0].count === "0",
    `${riskAutomated.rows[0].count} messaged`,
  );

  // 5. Audit completeness.
  const unaudited = await pg.query<{ count: string }>(
    `select count(*)::text as count from events e
      where e.status <> 'queued'
        and not exists (select 1 from actions a where a.event_id = e.id)`,
  );
  pass(
    "every processed event has an audit trail",
    unaudited.rows[0].count === "0",
    `${unaudited.rows[0].count} missing`,
  );

  const noReasoning = await pg.query<{ count: string }>(
    `select count(*)::text as count from actions
      where decision is null or decision->>'rationale' is null`,
  );
  pass(
    "every action records why it was taken",
    noReasoning.rows[0].count === "0",
    `${noReasoning.rows[0].count} without reasoning`,
  );

  // 6. Tenant isolation.
  const leaked = await pg.query<{ count: string }>(
    `select count(*)::text as count
       from actions a join events e on e.id = a.event_id
      where a.merchant_id <> e.merchant_id`,
  );
  pass(
    "no action was filed under the wrong merchant",
    leaked.rows[0].count === "0",
    `${leaked.rows[0].count} leaked`,
  );

  const crossCustomer = await pg.query<{ count: string }>(
    `select count(*)::text as count
       from events e join customers c on c.id = e.customer_id
      where e.merchant_id <> c.merchant_id`,
  );
  pass(
    "no event points at another merchant's customer",
    crossCustomer.rows[0].count === "0",
    `${crossCustomer.rows[0].count} crossed`,
  );

  // 7. Contact window.
  let outsideWindow = 0;
  for (const m of merchants) {
    const rows = await pg.query<{ sent_at: Date }>(
      `select sent_at from actions
        where merchant_id = $1 and sent_at is not null and sent_at >= $2`,
      [m.id, since],
    );
    for (const r of rows.rows) {
      if (!withinContactWindow(m, new Date(r.sent_at))) outsideWindow++;
    }
  }
  pass(
    "nothing was sent outside a merchant's contact window",
    outsideWindow === 0,
    `${outsideWindow} outside`,
  );

  // ── measured outcome ──
  console.log("\n─── Measured results ───");
  for (const m of merchants) {
    const { rows } = await pg.query<Record<string, string>>(
      `select
         count(*)::text as events,
         count(*) filter (where status = 'recovered')::text as recovered,
         count(*) filter (where status = 'stopped')::text as stopped,
         coalesce(sum(amount),0)::text as at_risk,
         coalesce(sum(coalesce(recovered_amount, amount))
                  filter (where status = 'recovered'),0)::text as recovered_amount
       from events where merchant_id = $1`,
      [m.id],
    );
    const r = rows[0];
    const sentRows = await pg.query<{ count: string }>(
      `select count(*)::text as count from actions
        where merchant_id = $1 and outcome in ('sent','delivered')`,
      [m.id],
    );
    console.log(`\n  ${m.business_name}`);
    console.log(`    events            ${r.events}`);
    console.log(`    messages sent     ${sentRows.rows[0].count}`);
    console.log(`    recovered         ${r.recovered}`);
    console.log(`    stopped           ${r.stopped}`);
    console.log(`    value at risk     ${formatINR(Number(r.at_risk))}`);
    console.log(`    value recovered   ${formatINR(Number(r.recovered_amount))}`);
  }

  if (DRY_RUN) {
    console.log(`\n  Dry run recorded ${recorded.length} messages (none sent).`);
    const byChannel = recorded.reduce<Record<string, number>>((acc, s) => {
      acc[s.channel] = (acc[s.channel] ?? 0) + 1;
      return acc;
    }, {});
    console.log("  By channel:", byChannel);
  }

  await pg.end();

  console.log(
    failures.length === 0
      ? "\nAll invariants held.\n"
      : `\n${failures.length} INVARIANT(S) VIOLATED: ${failures.join("; ")}\n`,
  );
  if (failures.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Batch run failed:", err);
  process.exit(1);
});
