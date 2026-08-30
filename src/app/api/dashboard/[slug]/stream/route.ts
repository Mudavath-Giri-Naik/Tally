/**
 * The dashboard's live feed.
 *
 * Server-sent events, not browser Realtime. `postgres_changes` from the
 * browser would need the publishable key in the bundle plus RLS policies
 * allowing anon SELECT - and with no authentication on the dashboard, those
 * policies could not be scoped to one merchant by any identity, so they would
 * expose every merchant's events and actions to anyone who opened the page.
 *
 * Instead the subscription lives here, holding the service key, filtered to one
 * merchant_id, and only that merchant's board is ever written to the stream.
 * This is push, not polling: nothing is fetched on a timer, and the recompute
 * happens because Postgres said something changed.
 *
 * When dashboard auth exists, this can become browser Realtime: scope the RLS
 * policies to the signed-in merchant and subscribe directly. Nothing about the
 * payload shape below would change.
 */
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireEnv } from "@/lib/env";
import { resolveMerchant } from "@/lib/merchants";
import { loadDashboard, rangeDays } from "@/lib/board";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Vercel's Hobby ceiling. The stream closes itself just short of it and the
// browser's EventSource reconnects on its own - a seam the viewer never sees,
// and no data is re-fetched that has not changed.
export const maxDuration = 60;

const STREAM_LIFETIME_MS = 55_000;
const HEARTBEAT_MS = 15_000;
/** Collapse a burst of writes - one worker tick touches several rows. */
const DEBOUNCE_MS = 400;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;

  const merchant = await resolveMerchant(slug).catch(() => null);
  if (!merchant) {
    return NextResponse.json({ error: "No such business." }, { status: 404 });
  }

  // The stream has to push the same window the page is showing, or a live
  // update would silently swap the viewer onto a different date range.
  const days = rangeDays(
    new URL(request.url).searchParams.get("days") ?? undefined,
  );

  const supabase = createClient(
    requireEnv("SUPABASE_URL", "the dashboard live feed"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY", "the dashboard live feed"),
    { realtime: { params: { eventsPerSecond: 5 } } },
  );

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, payload: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`),
          );
        } catch {
          // The client went away between the check and the write.
          closed = true;
        }
      };

      let timer: ReturnType<typeof setTimeout> | null = null;
      const push = async () => {
        try {
          send("board", await loadDashboard(merchant.id, days));
        } catch (err) {
          console.error("[stream] could not build the board", err);
        }
      };
      const pushSoon = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void push(), DEBOUNCE_MS);
      };

      // The current state first, so a reconnecting client is immediately
      // correct rather than correct only once something next changes.
      await push();

      const channel = supabase
        .channel(`board:${merchant.id}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "events",
            filter: `merchant_id=eq.${merchant.id}`,
          },
          pushSoon,
        )
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "actions",
            filter: `merchant_id=eq.${merchant.id}`,
          },
          pushSoon,
        )
        .subscribe((status) => {
          // Told to the client so the UI can say "live" honestly rather than
          // claiming it while the subscription is actually down.
          send("status", { realtime: status });
        });

      const heartbeat = setInterval(() => {
        // A comment frame: keeps proxies from closing an idle connection
        // without looking like a message to the client.
        if (!closed) {
          try {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            closed = true;
          }
        }
      }, HEARTBEAT_MS);

      const shutdown = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        if (timer) clearTimeout(timer);
        void supabase.removeChannel(channel);
        try {
          controller.close();
        } catch {
          // Already closed by the client disconnecting.
        }
      };

      setTimeout(shutdown, STREAM_LIFETIME_MS);
    },

    cancel() {
      // The browser navigated away or reconnected; stop paying for the socket.
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Nginx and some CDNs buffer responses by default, which would hold
      // every event until the stream closed.
      "X-Accel-Buffering": "no",
    },
  });
}
