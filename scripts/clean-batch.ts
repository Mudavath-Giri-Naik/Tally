/**
 * Remove everything a batch run seeded, and nothing else.
 *
 * `npm run batch` deliberately fills the board with a realistic week so the
 * invariants have something to hold against. That is the right shape for a
 * test run and the wrong shape for a demo: the cases a merchant actually
 * wants to show end up buried under forty synthetic ones.
 *
 *   npm run clean:batch -- --dry-run   list what would go
 *   npm run clean:batch                delete it
 *
 * Scoped by `metadata->>'batch'`, which only batch-test.ts sets. A real event
 * arriving from a Razorpay webhook never carries it, so a genuine case cannot
 * be caught by this no matter how closely it resembles the test data. Actions
 * go with their event through the existing `on delete cascade`.
 */
import { Client } from "pg";

const DRY_RUN = process.argv.slice(2).includes("--dry-run");

async function main() {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) {
    console.error(
      "Missing SUPABASE_DB_URL (needed for: deleting batch data).\n" +
        "Find it in Supabase under Project Settings -> Database -> Connection string (URI).",
    );
    process.exit(1);
  }

  const c = new Client({
    connectionString: url,
    ssl:
      url.includes("localhost") || url.includes("127.0.0.1")
        ? undefined
        : { rejectUnauthorized: false },
  });
  await c.connect();

  try {
    const { rows: preview } = await c.query<{
      business_name: string; events: string; actions: string;
    }>(
      `select m.business_name,
              count(distinct e.id)::text as events,
              count(a.id)::text          as actions
         from events e
         join merchants m on m.id = e.merchant_id
         left join actions a on a.event_id = e.id
        where e.metadata->>'batch' = 'true'
        group by 1 order by 1`,
    );

    if (preview.length === 0) {
      console.log("\nNothing seeded by a batch run is left.\n");
      return;
    }

    console.log(`\n${DRY_RUN ? "Would delete" : "Deleting"}:`);
    console.table(preview);

    if (DRY_RUN) {
      console.log("Dry run - nothing was deleted.\n");
      return;
    }

    const { rowCount: events } = await c.query(
      `delete from events where metadata->>'batch' = 'true'`,
    );

    /**
     * The customers those events invented, but only if nothing else points at
     * them. A batch tester who happens to share a phone number with a real
     * customer is the same row as that real customer - deleting it because a
     * test touched it would take the real person's opt-out and conversation
     * history with it.
     */
    const { rowCount: customers } = await c.query(
      `delete from customers c
        where c.email like '%@batch.test'
          and not exists (select 1 from events e where e.customer_id = c.id)`,
    );

    console.log(`\nDeleted ${events} event(s) and ${customers} test customer(s).`);
    console.log("Actions went with their events.\n");
  } finally {
    await c.end();
  }
}

main().catch((err) => {
  console.error("Cleanup failed:", err);
  process.exit(1);
});
