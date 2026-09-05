/**
 * Delete one merchant and everything scoped to it.
 *
 * customers, events and actions all carry `merchant_id references
 * merchants(id) on delete cascade` (see supabase/schema.sql), so deleting the
 * merchant row is the whole operation - nothing is left orphaned.
 *
 *   npm run delete-merchant -- --name=Mandate --dry-run   preview only
 *   npm run delete-merchant -- --name=Mandate              actually delete
 */
import { Client } from "pg";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const name = args.find((a) => a.startsWith("--name="))?.split("=").slice(1).join("=");

async function main() {
  if (!name) {
    console.error('Usage: npm run delete-merchant -- --name="Mandate" [--dry-run]');
    process.exit(1);
  }

  const url = process.env.SUPABASE_DB_URL;
  if (!url) {
    console.error(
      "Missing SUPABASE_DB_URL (needed for: deleting a merchant).\n" +
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
    const { rows: matches } = await c.query<{
      id: string; business_name: string; slug: string;
      customers: string; events: string; actions: string;
    }>(
      `select m.id, m.business_name, m.slug,
              count(distinct c.id)::text as customers,
              count(distinct e.id)::text as events,
              count(distinct a.id)::text as actions
         from merchants m
         left join customers c on c.merchant_id = m.id
         left join events e on e.merchant_id = m.id
         left join actions a on a.merchant_id = m.id
        where m.business_name ilike $1
        group by m.id, m.business_name, m.slug
        order by m.business_name`,
      [name],
    );

    if (matches.length === 0) {
      console.log(`\nNo merchant matching "${name}". Nothing to delete.\n`);
      return;
    }

    console.log(`\n${DRY_RUN ? "Would delete" : "About to delete"}:`);
    console.table(matches);

    if (matches.length > 1) {
      console.log(
        "\nMore than one merchant matched that name - stopping without deleting anything.\n" +
          "Re-run with a more exact --name to target just one.\n",
      );
      return;
    }

    if (DRY_RUN) {
      console.log("Dry run - nothing was deleted.\n");
      return;
    }

    const { rowCount } = await c.query(`delete from merchants where id = $1`, [
      matches[0].id,
    ]);
    console.log(
      `\nDeleted merchant "${matches[0].business_name}" (${rowCount} row) and ` +
        `${matches[0].customers} customer(s), ${matches[0].events} event(s), ` +
        `${matches[0].actions} action(s) with it.\n`,
    );
  } finally {
    await c.end();
  }
}

main().catch((err) => {
  console.error("Delete failed:", err);
  process.exit(1);
});
