/**
 * Phase 4 - the batch run.
 *
 * Generates a realistic mixed batch across every connected merchant, drives
 * the worker over it the way cron would, and then *verifies the guardrails
 * actually held* rather than assuming they did. The invariant checks at the
 * end are the point of this script: it is easy to send a lot of messages and
 * much harder to prove none of them broke a rule.
 *
 *   npm run batch -- --dry-run             record sends instead of making them
 *   npm run batch -- --per-merchant=12     batch size
 *   npm run batch -- --advance-hours=12    step the clock between rounds, so
 *                                          the full escalation ladder runs
 *   npm run batch                          real sends, real money, real people
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
import { formatCost } from "../src/lib/costs";
import type { EventType, RootCause, Merchant } from "../src/lib/types";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const PER_MERCHANT = Number(
  args.find((a) => a.startsWith("--per-merchant="))?.split("=")[1] ?? 10,
);
/**
 * Hours of simulated time to advance between rounds.
 *
 * Every schedule this engine writes lands in the future - the backoff between
 * attempt one and attempt two is measured in hours, and a hold across a closed
 * contact window in days. At wall-clock speed a batch therefore shows one
 * attempt per case and stops, which makes the escalation ladder and the
 * stopping rules - the two things worth proving - invisible.
 *
 * Advancing the clock between rounds drives the same production scheduling
 * code through the whole sequence in seconds. Nothing is mocked: the worker
 * evaluates real contact windows and real backoffs against a different now.
 * Zero keeps every round at the real current time.
 */
const ADVANCE_HOURS = Number(
  args.find((a) => a.startsWith("--advance-hours="))?.split("=")[1] ?? 0,
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
  { type: "payment_link_expired", reason: "payment_link_expired", amount: 199900, weight: 3 },
  { type: "cod_refused", reason: "cod_refused", amount: 89900, weight: 2 },
  { type: "payment_failed", reason: "insufficient_funds", amount: 1500000, weight: 1 }, // high value
];

const WEIGHTED = SCENARIOS.flatMap((s) => Array<typeof s>(s.weight).fill(s));

/** The duplicate-delivery probe: one webhook, delivered many times at once. */
const REPLAY_ID = `replay_probe_${Date.now()}`;
const REPLAY_COPIES = 25;

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
  console.log(`Seeded ${seeded} events.`);

  /**
   * Duplicate delivery.
   *
   * Razorpay retries a webhook it did not get a 2xx for, and a retry storm
   * arrives concurrently rather than politely in sequence. Every copy is a
   * chance to open a second case and chase the same person twice for one
   * failed payment - the most visible way this system could embarrass a
   * merchant. Fired all at once, because sequential delivery is the case
   * that was never in doubt: it is the race that finds a missing index.
   */
  await Promise.all(
    Array.from({ length: REPLAY_COPIES }, () =>
      ingestEvent({
        merchantId: merchants[0].id,
        providerEventId: REPLAY_ID,
        type: "payment_failed",
        reason: "insufficient_funds",
        amount: 99900,
        customerName: "Replay Probe",
        customerEmail: `${merchants[0].business_name.toLowerCase()}.replay@example.com`,
        customerPhone: "+919812340000",
        metadata: { batch: true, replay_probe: true },
      }).catch(() => null),
    ),
  );
  console.log(`Delivered the same webhook ${REPLAY_COPIES}x concurrently.\n`);

  // ── drive the workers ──
  const startedAt = new Date();
  const totals = { claimed: 0, sent: 0, scheduled: 0, stopped: 0, escalated: 0, failed: 0 };
  const transport = DRY_RUN ? recordingTransport : liveTransport;

  for (let round = 1; round <= 5; round++) {
    // Both workers share one instant. Two workers disagreeing about the time
    // would be a fiction production never produces, and the contact-window
    // check is exactly where that fiction would show up as a false pass.
    const now = new Date(startedAt.getTime() + (round - 1) * ADVANCE_HOURS * 3600_000);
    if (ADVANCE_HOURS > 0) {
      console.log(`
  [clock] round ${round} runs as ${now.toISOString()}`);
    }
    // Two workers, concurrently - the same contention production sees.
    const [a, b] = await Promise.all([
      runWorker({ workerId: `batch-a-${round}`, batchSize: 15, transport, now }),
      runWorker({ workerId: `batch-b-${round}`, batchSize: 15, transport, now }),
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

  // 2. Opt-out is absolute - from the moment it is given.
  //
  // Ordered against opted_out_at rather than the boolean alone. Someone who
  // was messaged, read it, and replied STOP was contacted entirely properly;
  // counting that as a violation flags the system working exactly as intended
  // and, worse, trains whoever reads this list to ignore a red line.
  const optedOut = await pg.query<{ count: string }>(
    `select count(*)::text as count
       from actions a
       join events e on e.id = a.event_id
       join customers c on c.id = e.customer_id
      where c.opted_out
        and a.outcome in ('sent','delivered')
        and c.opted_out_at is not null
        and coalesce(a.sent_at, a.created_at) > c.opted_out_at`,
  );
  pass(
    "no opted-out customer was contacted",
    optedOut.rows[0].count === "0",
    `${optedOut.rows[0].count} contacted`,
  );

  // 3. Dead-end causes were never retried.
  //
  // "schedule_retry" carries two meanings and only one of them is a bug.
  // Retrying a card that cannot work is the thing this check exists to catch.
  // Holding a message until the contact window opens is also written as a
  // schedule, and is the contact-window guardrail doing its job - on a card
  // that will never work, the deferred message is a request for a different
  // payment method, not another attempt at the dead one.
  //
  // Wall-clock runs never separated the two because they never landed outside
  // a contact window. Running the clock forward did, immediately.
  const badRetries = await pg.query<{ count: string }>(
    `select count(*)::text as count from actions
      where decision->>'intervention' = 'schedule_retry'
        and coalesce(decision->>'guardrail','') <> 'outside_contact_window'
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
  // Scoped to this run. A batch verifies what it just did; an event left in
  // some state by hand days ago is a question about that afternoon, and
  // dragging it in here means the list never goes green and so stops being
  // read at all.
  const unaudited = await pg.query<{ count: string }>(
    `select count(*)::text as count from events e
      where e.status <> 'queued'
        and e.created_at >= $1
        and not exists (select 1 from actions a where a.event_id = e.id)`,
    [since],
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

  // 8. Duplicate delivery.
  const replayed = await pg.query<{ events: string; actions: string }>(
    `select
       (select count(*)::text from events where provider_event_id = $1) as events,
       (select count(*)::text from actions a
          join events e on e.id = a.event_id
         where e.provider_event_id = $1
           and a.outcome in ('sent','delivered')) as actions`,
    [REPLAY_ID],
  );
  pass(
    `${REPLAY_COPIES} deliveries of one webhook created exactly one case`,
    replayed.rows[0].events === "1",
    `${replayed.rows[0].events} events`,
  );
  pass(
    "and the customer was messaged at most once for it",
    Number(replayed.rows[0].actions) <= 1,
    `${replayed.rows[0].actions} messages`,
  );

  // 9. The control arm was never contacted.
  const heldContacted = await pg.query<{ count: string }>(
    `select count(*)::text as count
       from actions a
       join events e on e.id = a.event_id
      where e.holdout and a.outcome in ('sent','delivered')`,
  );
  pass(
    "no held-back customer was contacted",
    heldContacted.rows[0].count === "0",
    `${heldContacted.rows[0].count} contacted`,
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

    // What it cost to recover it. A recovery figure without the spend beside
    // it is half of a subtraction.
    const spend = await pg.query<{ paise: string }>(
      `select coalesce(sum(cost_paise),0)::text as paise
         from actions where merchant_id = $1`,
      [m.id],
    );
    const spent = Number(spend.rows[0].paise);
    const gained = Number(r.recovered_amount);
    console.log(`    messaging cost    ${formatCost(spent)}`);
    console.log(
      `    return           ${spent > 0 ? ` ${Math.round(gained / spent)}x` : "  n/a"}`,
    );

    /**
     * The control arm.
     *
     * Both rates are computed the same way over the same window; the only
     * difference between the arms is whether Tally was allowed to speak. What
     * separates them is the part of recovery this agent can actually claim -
     * everything else was going to happen anyway.
     */
    const arms = await pg.query<{
      arm: string; events: string; recovered: string; amount: string;
    }>(
      `select case when holdout then 'control' else 'contacted' end as arm,
              count(*)::text as events,
              count(*) filter (where status = 'recovered')::text as recovered,
              coalesce(sum(coalesce(recovered_amount, amount))
                       filter (where status = 'recovered'),0)::text as amount
         from events where merchant_id = $1
        group by 1`,
      [m.id],
    );
    const contacted = arms.rows.find((a) => a.arm === "contacted");
    const control = arms.rows.find((a) => a.arm === "control");
    if (control && contacted) {
      const rate = (a: { events: string; recovered: string }) =>
        Number(a.events) === 0 ? 0 : (Number(a.recovered) / Number(a.events)) * 100;
      const lift = rate(contacted) - rate(control);
      console.log(
        `    contacted         ${contacted.recovered}/${contacted.events} recovered ` +
          `(${rate(contacted).toFixed(1)}%)`,
      );
      console.log(
        `    control           ${control.recovered}/${control.events} recovered ` +
          `(${rate(control).toFixed(1)}%)  - never contacted`,
      );
      console.log(`    incremental lift  ${lift >= 0 ? "+" : ""}${lift.toFixed(1)} points`);
      // Said out loud rather than left for the reader to work out, because a
      // lift computed over a handful of events is not evidence and quoting it
      // as though it were is the failure mode this whole arm exists to avoid.
      if (Number(control.events) < 30) {
        console.log(
          `    ! control arm is ${control.events} events - too small to be significant. ` +
            `The machinery is what is being shown here, not the number.`,
        );
      }
    } else if (!control) {
      console.log(
        `    control           none - set holdout_percent above 0 in settings ` +
          `to measure against an untouched arm`,
      );
    }
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
