/**
 * The single shared database handle.
 *
 * Tally's server always acts with the service-role key. That key bypasses RLS,
 * which means tenant isolation is enforced by this codebase, not by Postgres -
 * so every query below is scoped by merchant_id, without exception. The
 * repository functions in merchants.ts / events.ts exist so that scoping never
 * has to be remembered at a call site.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireEnv } from "./env";

let client: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (client) return client;
  const url = requireEnv("SUPABASE_URL", "connecting to the database");
  const key = requireEnv(
    "SUPABASE_SERVICE_ROLE_KEY",
    "connecting to the database with server privileges",
  );
  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-application-name": "tally" } },
  });
  return client;
}

/** Test seam - lets the integration tests point at a throwaway project. */
export function __setDbForTesting(c: SupabaseClient | null): void {
  client = c;
}
