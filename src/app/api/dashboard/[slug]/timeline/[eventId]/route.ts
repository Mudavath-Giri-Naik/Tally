/**
 * One event's timeline, for the detail panel.
 *
 * Fetched on demand rather than shipped with the board: a merchant opens one
 * row at a time, and sending every event's full action history with the table
 * would make the initial payload dozens of times larger for something almost
 * none of it gets read.
 *
 * Scoped by merchant as well as event id, so a guessed event id from another
 * tenant returns nothing rather than someone else's conversation.
 */
import { NextResponse } from "next/server";
import { resolveMerchant } from "@/lib/merchants";
import { eventTimeline } from "@/lib/board";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; eventId: string }> },
): Promise<NextResponse> {
  const { slug, eventId } = await params;

  if (!UUID_RE.test(eventId)) {
    return NextResponse.json({ error: "Unknown event." }, { status: 404 });
  }

  const merchant = await resolveMerchant(slug).catch(() => null);
  if (!merchant) {
    return NextResponse.json({ error: "No such business." }, { status: 404 });
  }

  try {
    return NextResponse.json({ entries: await eventTimeline(merchant.id, eventId) });
  } catch (err) {
    console.error("[timeline] failed", err);
    return NextResponse.json(
      { error: "Could not load that timeline right now." },
      { status: 500 },
    );
  }
}
