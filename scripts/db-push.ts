/**
 * Apply supabase/schema.sql to the database in SUPABASE_DB_URL.
 *
 * The schema is written to be idempotent (create if not exists / create or
 * replace), so running this repeatedly is safe and is how migrations are
 * applied during development.
 *
 *   npm run db:push
 */
import { readFileSync } from "node:fs";
import { Client } from "pg";

async function main() {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) {
    console.error(
      "Missing SUPABASE_DB_URL (needed for: applying the schema).\n" +
        "Find it in Supabase under Project Settings -> Database -> Connection string (URI).",
    );
    process.exit(1);
  }

  const schema = readFileSync(
    new URL("../supabase/schema.sql", import.meta.url),
    "utf8",
  );

  const client = new Client({
    connectionString: url,
    // Supabase's pooler presents a certificate for a different host name.
    ssl: url.includes("localhost") || url.includes("127.0.0.1")
      ? undefined
      : { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    await client.query(schema);
    console.log("Schema applied.");

    const { rows } = await client.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' order by table_name`,
    );
    console.log("Tables:", rows.map((r) => r.table_name).join(", "));

    const { rows: fns } = await client.query<{ proname: string }>(
      `select proname from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' order by proname`,
    );
    console.log("Functions:", fns.map((f) => f.proname).join(", "));
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Schema push failed:", err.message ?? err);
  process.exit(1);
});
