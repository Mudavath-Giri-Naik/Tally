/**
 * The admin's chat with the agent, about one case.
 *
 * Scoped by merchant as well as event id, same as the override and timeline
 * routes, so a guessed event id from another tenant cannot be talked to. The
 * interpreting and the acting both live in lib/agent/admin-chat - this route
 * is the HTTP shape around it, and the place where a thrown error becomes a
 * sentence rather than a stack trace.
 */
import { NextResponse } from "next/server";
import { resolveMerchant } from "@/lib/merchants";
import { getCustomer } from "@/lib/events";
import { boardRowForEvent, eventTimeline } from "@/lib/board";
import { askAgent, explainFailure } from "@/lib/agent/admin-chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A send and a model call in one request. The default 10s is not enough on a
// cold provider, and 60 deploys on Hobby as well as Pro.
export const maxDuration = 60;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_QUESTION = 1000;

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

  let question: unknown;
  try {
    ({ question } = (await request.json()) as { question?: unknown });
  } catch {
    return NextResponse.json({ error: "That request made no sense." }, { status: 400 });
  }

  if (typeof question !== "string" || question.trim().length === 0) {
    return NextResponse.json({ error: "Ask me something first." }, { status: 400 });
  }
  if (question.length > MAX_QUESTION) {
    return NextResponse.json(
      { error: "That is longer than I can take in one go - trim it down." },
      { status: 400 },
    );
  }

  const row = await boardRowForEvent(merchant.id, eventId).catch(() => null);
  if (!row) {
    return NextResponse.json({ error: "Unknown case." }, { status: 404 });
  }

  try {
    const [customer, timeline] = await Promise.all([
      getCustomer(row.customer_id),
      eventTimeline(merchant.id, eventId).catch(() => []),
    ]);

    const result = await askAgent({
      merchant,
      row,
      customer,
      timeline,
      question: question.trim(),
    });

    // The row is re-read after the fact rather than trusted from before it:
    // an action taken in this same request has already changed the case, and
    // the panel wants the state it is in now, not the one it was asked about.
    const updated = result.performed
      ? await boardRowForEvent(merchant.id, eventId).catch(() => row)
      : row;

    return NextResponse.json({ ...result, row: updated });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    console.error("[ask] failed", { event: eventId, err });
    return NextResponse.json(
      {
        reply: "Something went wrong at my end.",
        action: "none",
        performed: false,
        error: explainFailure(raw),
        row,
      },
      { status: 200 },
    );
  }
}
