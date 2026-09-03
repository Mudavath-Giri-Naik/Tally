/**
 * Merchant settings.
 *
 * PATCH /api/merchants/:id — change the contact rules from the dashboard.
 *
 * Only the operational settings are writable. Credentials are deliberately
 * absent: rotating a Razorpay key means re-onboarding, so that there is no
 * endpoint capable of overwriting a working credential with a typo.
 */
import { NextResponse } from "next/server";
import {
  getMerchant,
  updateMerchantSettings,
  toPublic,
  ValidationError,
} from "@/lib/merchants";
import { PUBLIC_URL } from "@/lib/env";
import { normaliseWorkflows } from "@/lib/workflows";
import { isProviderName } from "@/lib/ai-keys";
import type { Channel, Merchant } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CHANNELS: Channel[] = ["email", "whatsapp", "voice"];
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;

type Patch = Partial<
  Pick<
    Merchant,
    | "contact_window_start"
    | "contact_window_end"
    | "timezone"
    | "max_attempts"
    | "holdout_percent"
    | "channels_enabled"
    | "workflows_enabled"
    | "ai_provider"
    | "ai_model"
    | "active"
  >
>;

/** Build the patch from the body, rejecting anything the schema would. */
function readPatch(body: Record<string, unknown>): Patch {
  const patch: Patch = {};

  if (body.ai_model !== undefined) {
    const value = body.ai_model;
    if (value === null || value === "") {
      patch.ai_model = null;
    } else if (typeof value === "string" && value.length <= 100) {
      // Not checked against a list: providers add and retire models faster
      // than any allowlist here would be updated, and a wrong name fails
      // loudly on the next call rather than corrupting anything. The health
      // check beside this field is what makes that safe to allow.
      patch.ai_model = value.trim();
    } else {
      throw new ValidationError("ai_model", "That is not a valid model name.");
    }
  }

  if (body.ai_provider !== undefined) {
    const value = body.ai_provider;
    // Null is meaningful: it means "whatever the platform default is", which
    // is what every merchant created before this had.
    if (value === null || value === "") {
      patch.ai_provider = null;
    } else if (isProviderName(value)) {
      patch.ai_provider = value;
    } else {
      throw new ValidationError("ai_provider", "Pick one of the listed providers.");
    }
  }

  for (const key of ["contact_window_start", "contact_window_end"] as const) {
    if (body[key] === undefined) continue;
    const value = String(body[key]);
    if (!TIME_RE.test(value)) {
      throw new ValidationError(key, "Use a 24-hour time like 08:00.");
    }
    patch[key] = value;
  }

  if (body.timezone !== undefined) {
    const tz = String(body.timezone);
    // Reject an unknown zone here rather than at send time, where it would
    // throw inside the worker and look like a delivery failure.
    try {
      new Intl.DateTimeFormat("en-IN", { timeZone: tz });
    } catch {
      throw new ValidationError("timezone", `${tz} is not a known time zone.`);
    }
    patch.timezone = tz;
  }

  if (body.max_attempts !== undefined) {
    const n = Number(body.max_attempts);
    if (!Number.isInteger(n) || n < 1 || n > 10) {
      throw new ValidationError(
        "max_attempts",
        "Maximum attempts must be a whole number between 1 and 10.",
      );
    }
    patch.max_attempts = n;
  }

  if (body.holdout_percent !== undefined) {
    const n = Number(body.holdout_percent);
    if (!Number.isInteger(n) || n < 0 || n > 50) {
      throw new ValidationError("holdout_percent", "The holdout must be a whole percentage between 0 and 50.");
    }
    patch.holdout_percent = n;
  }

  if (body.channels_enabled !== undefined) {
    const raw = body.channels_enabled;
    const channels = Array.isArray(raw)
      ? raw.filter((c): c is Channel => CHANNELS.includes(c as Channel))
      : [];
    if (channels.length === 0) {
      throw new ValidationError(
        "channels_enabled",
        "Keep at least one channel on, or Tally has no way to reach anyone.",
      );
    }
    patch.channels_enabled = channels;
  }

  if (body.workflows_enabled !== undefined) {
    const workflows = normaliseWorkflows(body.workflows_enabled);
    if (workflows.length === 0) {
      throw new ValidationError(
        "workflows_enabled",
        "Keep at least one workflow on, or Tally has nothing to recover.",
      );
    }
    patch.workflows_enabled = workflows;
  }

  if (body.active !== undefined) {
    patch.active = Boolean(body.active);
  }

  return patch;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ merchantId: string }> },
): Promise<NextResponse> {
  const { merchantId } = await params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Malformed JSON body." }, { status: 400 });
  }

  try {
    const patch = readPatch(body);
    if (Object.keys(patch).length === 0) {
      return NextResponse.json(
        { error: "Nothing to update." },
        { status: 422 },
      );
    }

    const existing = await getMerchant(merchantId);
    if (!existing) {
      return NextResponse.json({ error: "No such business." }, { status: 404 });
    }

    // The window is only meaningful as a pair, so validate the pair - the
    // result of each field passing alone can still be a window that never opens.
    const start = patch.contact_window_start ?? existing.contact_window_start;
    const end = patch.contact_window_end ?? existing.contact_window_end;
    if (start.slice(0, 5) >= end.slice(0, 5)) {
      return NextResponse.json(
        {
          error: "The contact window must start before it ends.",
          field: "contact_window_end",
        },
        { status: 422 },
      );
    }

    const updated = await updateMerchantSettings(merchantId, patch);
    return NextResponse.json({ merchant: toPublic(updated, PUBLIC_URL()) });
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json(
        { error: err.message, field: err.field },
        { status: 422 },
      );
    }
    console.error("[settings] update failed", err);
    return NextResponse.json(
      { error: "Could not save those settings right now." },
      { status: 500 },
    );
  }
}
