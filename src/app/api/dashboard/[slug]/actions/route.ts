/**
 * The Audit Trail's data, paginated.
 *
 * Scoped by merchant the same way every dashboard reporting query is - a
 * customer id or an outcome bucket from another tenant simply never appears
 * in the result rather than needing to be rejected.
 */
import { NextResponse } from "next/server";
import { resolveMerchant } from "@/lib/merchants";
import { listActions, isActionType } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  const merchant = await resolveMerchant(slug).catch(() => null);
  if (!merchant) {
    return NextResponse.json({ error: "No such business." }, { status: 404 });
  }

  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") ?? 25);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const customerId = url.searchParams.get("customer") || null;
  const typeParam = url.searchParams.get("type");
  const type = isActionType(typeParam) ? typeParam : null;

  try {
    const page = await listActions(merchant, {
      limit: Number.isFinite(limit) ? limit : 25,
      offset: Number.isFinite(offset) ? offset : 0,
      customerId,
      type,
    });
    return NextResponse.json(page);
  } catch (err) {
    console.error("[audit] failed", err);
    return NextResponse.json(
      { error: "Could not load the audit trail right now." },
      { status: 500 },
    );
  }
}
