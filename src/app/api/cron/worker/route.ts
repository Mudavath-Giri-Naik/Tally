/**
 * The worker tick. Vercel Cron calls this every minute (see vercel.json).
 *
 * Deliberately thin: all the logic is in lib/agent/worker.ts so the same code
 * path runs from `npm run worker` locally, from a test, and from cron.
 */
import { NextResponse } from "next/server";
import { runWorker } from "@/lib/agent/worker";
import { optionalEnv } from "@/lib/env";
import { timingSafeEqual } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Vercel's default is 10s; a batch that sends real messages needs longer.
export const maxDuration = 300;

function authorised(request: Request): boolean {
  const expected = optionalEnv("CRON_SECRET");
  // Without a configured secret this is local development. Vercel Cron also
  // sets x-vercel-cron, which is only settable by the platform.
  if (!expected) return true;

  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : header;

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!authorised(request)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  try {
    const url = new URL(request.url);
    const batchSize = Number(url.searchParams.get("batch") ?? "20");

    const report = await runWorker({
      batchSize: Number.isFinite(batchSize)
        ? Math.min(Math.max(batchSize, 1), 100)
        : 20,
    });

    return NextResponse.json(report);
  } catch (err) {
    console.error("[cron] worker run failed", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/** Same handler for POST, so the tick can be triggered manually too. */
export const POST = GET;
