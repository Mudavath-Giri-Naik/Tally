/**
 * Manual admin overrides - the kebab menu on the customer table.
 *
 * Scoped by merchant as well as event id, same as the timeline route, so a
 * guessed event id from another tenant cannot be acted on. The heavy lifting
 * (re-deriving the case's real status, validating the action against it,
 * applying the mutation, writing the audit row) all lives in
 * `applyAdminOverride` - this route is just the HTTP shape around it.
 */
import { NextResponse } from "next/server";
import { resolveMerchant } from "@/lib/merchants";
import { applyAdminOverride, AdminActionError } from "@/lib/events";
import { ADMIN_ACTIONS } from "@/lib/admin-actions";
import type { AdminActionId } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isAdminActionId(v: unknown): v is AdminActionId {
  return typeof v === "string" && v in ADMIN_ACTIONS;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; eventId: string }> },
): Promise<NextResponse> {
  const { slug, eventId } = await params;

  if (!UUID_RE.test(eventId)) {
    return NextResponse.json({ error: "Unknown case." }, { status: 404 });
  }

  const merchant = await resolveMerchant(slug).catch(() => null);
  if (!merchant) {
    return NextResponse.json({ error: "No such business." }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Malformed JSON body." }, { status: 400 });
  }

  if (!isAdminActionId(body.action)) {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }

  try {
    const row = await applyAdminOverride({
      merchantId: merchant.id,
      eventId,
      action: body.action,
      reasonText: typeof body.reasonText === "string" ? body.reasonText : null,
      snoozeUntil: typeof body.snoozeUntil === "string" ? body.snoozeUntil : null,
    });
    return NextResponse.json({ row });
  } catch (err) {
    if (err instanceof AdminActionError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("[admin-override] failed", err);
    return NextResponse.json(
      { error: "Could not apply that action right now." },
      { status: 500 },
    );
  }
}
