/**
 * Merchant onboarding and credential access.
 *
 * Two rules this module exists to enforce:
 *
 *  1. A credential is encrypted on the way in and decrypted only at the moment
 *     Tally acts for that merchant. Nothing else in the codebase touches
 *     `encrypt`/`decrypt` for merchant fields.
 *  2. A merchant record never leaves this module with plaintext credentials
 *     attached. `PublicMerchant` is what the dashboard and API return - it is
 *     structurally incapable of carrying a secret, because the fields are not
 *     on the type.
 */
import { db } from "./supabase";
import {
  encrypt,
  decrypt,
  encryptNullable,
  decryptNullable,
  generateWebhookSecret,
  maskCredential,
} from "./crypto";
import { DEFAULT_WORKFLOWS, normaliseWorkflows, type WorkflowId } from "./workflows";
import type { Merchant, Channel } from "./types";

/** What a merchant record looks like to everything outside this module. */
export interface PublicMerchant {
  id: string;
  business_name: string;
  slug: string;
  razorpay_key_id_masked: string;
  has_whatsapp: boolean;
  has_voice: boolean;
  contact_window_start: string;
  contact_window_end: string;
  timezone: string;
  max_attempts: number;
  holdout_percent: number;
  channels_enabled: Channel[];
  workflows_enabled: WorkflowId[];
  active: boolean;
  created_at: string;
  webhook_url: string;
  dashboard_url: string;
}

export interface OnboardingInput {
  business_name: string;
  razorpay_key_id: string;
  razorpay_key_secret: string;
  whatsapp_number?: string | null;
  voice_number?: string | null;
  contact_window_start?: string;
  contact_window_end?: string;
  timezone?: string;
  max_attempts?: number;
  holdout_percent?: number;
  channels_enabled?: Channel[];
  workflows_enabled?: WorkflowId[];
}

export class ValidationError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "ValidationError";
    this.field = field;
  }
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;
// E.164. Twilio will not accept anything else, so reject it at the door with a
// message the merchant can act on rather than failing at send time.
const PHONE_RE = /^\+[1-9]\d{7,14}$/;

function validate(input: OnboardingInput): void {
  if (!input.business_name?.trim()) {
    throw new ValidationError("business_name", "Business name is required.");
  }
  if (!input.razorpay_key_id?.trim()) {
    throw new ValidationError("razorpay_key_id", "Razorpay Key ID is required.");
  }
  if (!/^rzp_(test|live)_/.test(input.razorpay_key_id.trim())) {
    throw new ValidationError(
      "razorpay_key_id",
      "That does not look like a Razorpay Key ID - it should start with rzp_test_ or rzp_live_.",
    );
  }
  if (!input.razorpay_key_secret?.trim()) {
    throw new ValidationError(
      "razorpay_key_secret",
      "Razorpay Key Secret is required.",
    );
  }
  for (const [field, value] of [
    ["whatsapp_number", input.whatsapp_number],
    ["voice_number", input.voice_number],
  ] as const) {
    if (value && !PHONE_RE.test(value.trim())) {
      throw new ValidationError(
        field,
        `${field.replace("_", " ")} must be in international format, e.g. +919876543210.`,
      );
    }
  }
  for (const [field, value] of [
    ["contact_window_start", input.contact_window_start],
    ["contact_window_end", input.contact_window_end],
  ] as const) {
    if (value && !TIME_RE.test(value)) {
      throw new ValidationError(field, `${field} must be a 24-hour time like 08:00.`);
    }
  }
  if (
    input.max_attempts !== undefined &&
    (!Number.isInteger(input.max_attempts) ||
      input.max_attempts < 1 ||
      input.max_attempts > 10)
  ) {
    throw new ValidationError(
      "max_attempts",
      "Maximum attempts must be a whole number between 1 and 10.",
    );
  }
  if (
    input.holdout_percent !== undefined &&
    (!Number.isInteger(input.holdout_percent) ||
      input.holdout_percent < 0 ||
      input.holdout_percent > 50)
  ) {
    throw new ValidationError("holdout_percent", "The holdout must be a whole percentage between 0 and 50.");
  }
  if (input.channels_enabled && input.channels_enabled.length === 0) {
    throw new ValidationError(
      "channels_enabled",
      "Enable at least one channel, or Tally has no way to reach anyone.",
    );
  }
  if (input.workflows_enabled && input.workflows_enabled.length === 0) {
    throw new ValidationError(
      "workflows_enabled",
      "Enable at least one workflow, or Tally has nothing to recover.",
    );
  }
}

export function toPublic(m: Merchant, baseUrl: string): PublicMerchant {
  let masked = "****";
  try {
    masked = maskCredential(decrypt(m.razorpay_key_id, "razorpay_key_id"));
  } catch {
    // A key encrypted under a rotated encryption key. Surface it as unreadable
    // rather than crashing the whole dashboard.
    masked = "unreadable - key rotated";
  }
  return {
    id: m.id,
    business_name: m.business_name,
    slug: m.slug,
    razorpay_key_id_masked: masked,
    has_whatsapp: m.whatsapp_number !== null,
    has_voice: m.voice_number !== null,
    contact_window_start: m.contact_window_start,
    contact_window_end: m.contact_window_end,
    timezone: m.timezone,
    max_attempts: m.max_attempts,
    // Null on a row written before the holdout existed, until the migration's
    // default lands. Zero is also the right answer for such a merchant: they
    // never opted into one.
    holdout_percent: m.holdout_percent ?? 0,
    channels_enabled: m.channels_enabled,
    // A row written before workflows existed reads back as null until the
    // migration's default lands, so fall back rather than render "none on".
    workflows_enabled:
      m.workflows_enabled?.length ? m.workflows_enabled : DEFAULT_WORKFLOWS,
    active: m.active,
    created_at: m.created_at,
    webhook_url: `${baseUrl}/api/webhooks/razorpay/${m.id}`,
    // The slug, not the id: this is the address a merchant bookmarks and
    // reads aloud. The id still resolves, so old links keep working.
    dashboard_url: `${baseUrl}/dashboard/${m.slug}`,
  };
}

/**
 * Onboard a merchant. Everything sensitive is encrypted here, before the row
 * is built - there is no code path that writes a plaintext credential.
 */
export async function createMerchant(
  input: OnboardingInput,
): Promise<{ merchant: Merchant; webhook_secret: string }> {
  validate(input);

  const webhookSecret = generateWebhookSecret();
  const row = {
    business_name: input.business_name.trim(),
    razorpay_key_id: encrypt(input.razorpay_key_id.trim(), "razorpay_key_id"),
    razorpay_key_secret: encrypt(
      input.razorpay_key_secret.trim(),
      "razorpay_key_secret",
    ),
    webhook_secret: webhookSecret,
    whatsapp_number: encryptNullable(
      input.whatsapp_number?.trim() || null,
      "whatsapp_number",
    ),
    voice_number: encryptNullable(
      input.voice_number?.trim() || null,
      "voice_number",
    ),
    contact_window_start: input.contact_window_start ?? "08:00",
    contact_window_end: input.contact_window_end ?? "19:00",
    timezone: input.timezone ?? "Asia/Kolkata",
    max_attempts: input.max_attempts ?? 3,
    holdout_percent: input.holdout_percent ?? 0,
    channels_enabled: input.channels_enabled ?? ["email", "whatsapp"],
    workflows_enabled: input.workflows_enabled?.length
      ? normaliseWorkflows(input.workflows_enabled)
      : DEFAULT_WORKFLOWS,
  };

  const { data, error } = await db()
    .from("merchants")
    .insert(row)
    .select()
    .single();

  if (error) throw new Error(`Could not create merchant: ${error.message}`);
  // Returned once, at onboarding, so the merchant can paste it into Razorpay.
  // It is never shown again.
  return { merchant: data as Merchant, webhook_secret: webhookSecret };
}

export async function getMerchant(id: string): Promise<Merchant | null> {
  const { data, error } = await db()
    .from("merchants")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Could not load merchant: ${error.message}`);
  return (data as Merchant) ?? null;
}

/**
 * Look a merchant up by its URL slug.
 *
 * The slug is assigned by a database trigger (see schema.sql), so this is
 * read-only - nothing here invents one.
 */
export async function getMerchantBySlug(slug: string): Promise<Merchant | null> {
  const { data, error } = await db()
    .from("merchants")
    .select("*")
    .eq("slug", slug.toLowerCase())
    .maybeSingle();
  if (error) throw new Error(`Could not load merchant: ${error.message}`);
  return (data as Merchant) ?? null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve whatever is in the URL to a merchant.
 *
 * Dashboards are addressed by slug, but ids were the address before slugs
 * existed and are still what the onboarding response used to hand out. Both
 * resolve, so no bookmark breaks. Anything shaped like a uuid is tried as one;
 * everything else is a slug, which also keeps a slug that happens to look
 * like a uuid from being sent to Postgres as one and erroring.
 */
export async function resolveMerchant(
  handle: string,
): Promise<Merchant | null> {
  return UUID_RE.test(handle)
    ? getMerchant(handle)
    : getMerchantBySlug(handle);
}

export async function listMerchants(): Promise<Merchant[]> {
  const { data, error } = await db()
    .from("merchants")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Could not list merchants: ${error.message}`);
  return (data ?? []) as Merchant[];
}

/**
 * The merchant's own Razorpay credentials, decrypted for one use.
 *
 * Call this at the point of action and let the value go out of scope - do not
 * cache it, log it, or attach it to anything that gets serialised.
 */
export interface RazorpayCredentials {
  keyId: string;
  keySecret: string;
}

export function razorpayCredentials(m: Merchant): RazorpayCredentials {
  return {
    keyId: decrypt(m.razorpay_key_id, "razorpay_key_id"),
    keySecret: decrypt(m.razorpay_key_secret, "razorpay_key_secret"),
  };
}

export function whatsappNumber(m: Merchant): string | null {
  return decryptNullable(m.whatsapp_number, "whatsapp_number");
}

export function voiceNumber(m: Merchant): string | null {
  return decryptNullable(m.voice_number, "voice_number");
}

export async function updateMerchantSettings(
  id: string,
  patch: Partial<
    Pick<
      Merchant,
      | "contact_window_start"
      | "contact_window_end"
      | "timezone"
      | "max_attempts"
      | "holdout_percent"
      | "channels_enabled"
      | "workflows_enabled"
      | "active"
    >
  >,
): Promise<Merchant> {
  const { data, error } = await db()
    .from("merchants")
    .update(patch)
    .eq("id", id)
    .select()
    .single();
  if (error) throw new Error(`Could not update merchant: ${error.message}`);
  return data as Merchant;
}

/**
 * Delete a business and everything scoped to it.
 *
 * `customers`, `events` and `actions` all carry `merchant_id references
 * merchants(id) on delete cascade` (see supabase/schema.sql), so removing the
 * merchant row is the whole operation - nothing needs deleting separately, and
 * nothing is left behind pointing at a business that no longer exists.
 *
 * There is no undo. The caller is where a confirmation belongs, not here.
 */
export async function deleteMerchant(id: string): Promise<void> {
  const { error } = await db().from("merchants").delete().eq("id", id);
  if (error) throw new Error(`Could not delete merchant: ${error.message}`);
}
