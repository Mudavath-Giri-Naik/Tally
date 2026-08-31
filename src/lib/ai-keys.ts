/**
 * The model credentials, as a pool.
 *
 * One key is one rate limit. Free tiers throttle per project, so a single
 * environment variable means the whole product degrades to templates the
 * moment that project is busy - which is exactly what happened in practice.
 *
 * A pool turns that into a queue: keys are tried in priority order, a key the
 * provider says is spent goes into cooldown rather than being retried on
 * every request, and when a provider has nothing left the next provider is
 * tried before anything degrades. Cooldown expires on its own, so a throttle
 * heals without anyone re-enabling anything.
 *
 * Platform-level on purpose. A merchant's Razorpay keys are theirs and move
 * their money; an inference key is the operator's own cost and is shared. What
 * a merchant chooses is the provider, not the key.
 */
import { db } from "./supabase";
import { decrypt, encrypt } from "./crypto";
import { optionalEnv } from "./env";

export type ProviderName = "groq" | "gemini" | "anthropic";

export const PROVIDERS: ProviderName[] = ["groq", "gemini", "anthropic"];

/**
 * Groq first by default: it is materially faster than the alternatives at
 * this size of prompt, and the whole panel waits on these calls.
 */
export const DEFAULT_PROVIDER: ProviderName = "groq";

export function isProviderName(v: unknown): v is ProviderName {
  return typeof v === "string" && (PROVIDERS as string[]).includes(v);
}

export interface AiKey {
  id: string;
  provider: ProviderName;
  label: string;
  /** Decrypted only here, at the moment of use. */
  apiKey: string;
  model: string | null;
}

interface KeyRow {
  id: string;
  provider: string;
  label: string;
  api_key: string;
  model: string | null;
}

/**
 * Every usable key, best first, for the given provider order.
 *
 * Keys in cooldown are left out by the query rather than filtered after, so a
 * throttled key costs nothing to skip.
 */
export async function usableKeys(order: ProviderName[]): Promise<AiKey[]> {
  const { data, error } = await db()
    .from("ai_keys")
    .select("id, provider, label, api_key, model")
    .eq("active", true)
    .in("provider", order)
    .or(`cooldown_until.is.null,cooldown_until.lt.${new Date().toISOString()}`)
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) throw new Error(`Could not read the model keys: ${error.message}`);

  const rows = (data ?? []) as KeyRow[];
  const keys: AiKey[] = [];

  for (const row of rows) {
    try {
      keys.push({
        id: row.id,
        provider: row.provider as ProviderName,
        label: row.label,
        apiKey: decrypt(row.api_key, "ai_api_key"),
        model: row.model,
      });
    } catch {
      // Encrypted under a rotated encryption key. Skipping is right: it is
      // unusable, and failing the whole request over one bad row would take
      // the working keys down with it.
        console.error("[ai-keys] could not decrypt key", { id: row.id, label: row.label });
    }
  }

  // Provider order is the caller's preference, which the SQL cannot express.
  return keys.sort((a, b) => order.indexOf(a.provider) - order.indexOf(b.provider));
}

/**
 * A key the provider has told us is spent, parked until it is worth trying.
 *
 * The wait is the provider's own where it stated one - a per-minute throttle
 * clears in under a minute and should not cost the key an hour of exile.
 */
export async function coolDown(
  keyId: string,
  reason: string,
  retryAfterMs?: number,
): Promise<void> {
  const wait = Math.min(Math.max(retryAfterMs ?? 60_000, 10_000), 6 * 3600_000);
  await db()
    .from("ai_keys")
    .update({
      cooldown_until: new Date(Date.now() + wait).toISOString(),
      last_error: reason.slice(0, 500),
    })
    .eq("id", keyId);
}

export async function markUsed(keyId: string): Promise<void> {
  await db()
    .from("ai_keys")
    .update({ last_used_at: new Date().toISOString(), last_error: null })
    .eq("id", keyId);
}

/**
 * The order to try providers in for one merchant.
 *
 * Their choice first, then everything else - a merchant who picked Groq would
 * rather be answered by Gemini than not answered at all, and the alternative
 * is falling back to a template.
 */
export function providerOrder(preferred?: string | null): ProviderName[] {
  // An explicit TALLY_LLM_PROVIDER is a pin, not a preference: an operator who
  // names one backend does not want quiet failover to another they may not
  // have keys, budget or approval for. It is also what makes a deployment
  // reproducible - the same env gives the same backend every time.
  const pinned = optionalEnv("TALLY_LLM_PROVIDER")?.toLowerCase();
  if (!isProviderName(preferred) && isProviderName(pinned)) return [pinned];

  const first = isProviderName(preferred) ? preferred : DEFAULT_PROVIDER;
  return [first, ...PROVIDERS.filter((p) => p !== first)];
}

/**
 * The keys held in the environment, as a last resort.
 *
 * The pool is the real source, but a deployment that has not been given one
 * yet should still work exactly as it did before this existed.
 */
export function envKeys(order: ProviderName[]): AiKey[] {
  const fromEnv: Array<[ProviderName, string | undefined, string | undefined]> = [
    ["groq", optionalEnv("GROQ_API_KEY"), optionalEnv("GROQ_MODEL")],
    ["gemini", optionalEnv("GEMINI_API_KEY"), optionalEnv("GEMINI_MODEL")],
    ["anthropic", optionalEnv("ANTHROPIC_API_KEY"), optionalEnv("ANTHROPIC_MODEL")],
  ];

  return fromEnv
    .filter(([provider, key]) => key && order.includes(provider))
    .map(([provider, key, model]) => ({
      id: `env:${provider}`,
      provider,
      label: `${provider} (environment)`,
      apiKey: key!,
      model: model ?? null,
    }))
    .sort((a, b) => order.indexOf(a.provider) - order.indexOf(b.provider));
}

/** Add a key to the pool. The plaintext is encrypted here and never stored raw. */
export async function addKey(input: {
  provider: ProviderName;
  label: string;
  apiKey: string;
  model?: string | null;
  priority?: number;
}): Promise<void> {
  const { error } = await db().from("ai_keys").insert({
    provider: input.provider,
    label: input.label,
    api_key: encrypt(input.apiKey, "ai_api_key"),
    model: input.model ?? null,
    priority: input.priority ?? 100,
  });
  if (error) throw new Error(`Could not store that key: ${error.message}`);
}

/** What the operator can see about the pool, without decrypting anything. */
export async function listKeys(): Promise<
  Array<{
    id: string;
    provider: string;
    label: string;
    model: string | null;
    priority: number;
    active: boolean;
    cooldown_until: string | null;
    last_error: string | null;
    last_used_at: string | null;
  }>
> {
  const { data, error } = await db()
    .from("ai_keys")
    .select("id, provider, label, model, priority, active, cooldown_until, last_error, last_used_at")
    .order("provider", { ascending: true })
    .order("priority", { ascending: true });
  if (error) throw new Error(`Could not list the model keys: ${error.message}`);
  return data ?? [];
}
