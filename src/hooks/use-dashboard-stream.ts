"use client";

/**
 * The dashboard's live data, for whichever page is showing it.
 *
 * Both Overview and Customers render the same board payload from the same
 * SSE endpoint, so the subscription lives here rather than being written
 * twice. `setData` is handed back because an admin override merges one
 * updated row in directly instead of waiting for the next push.
 */
import { useEffect, useState } from "react";

import type { Dashboard } from "@/lib/board";

export function useDashboardStream(slug: string, initial: Dashboard) {
  const [data, setData] = useState<Dashboard>(initial);
  const [live, setLive] = useState(false);

  // A server render for a new range replaces the whole payload.
  useEffect(() => setData(initial), [initial]);

  useEffect(() => {
    const source = new EventSource(`/api/dashboard/${slug}/stream?days=${initial.days}`);
    source.addEventListener("board", (e) => {
      try {
        setData(JSON.parse((e as MessageEvent).data) as Dashboard);
        setLive(true);
      } catch {
        // A truncated frame; the next push carries the same state.
      }
    });
    // Dropping is normal: the server closes the stream just short of the
    // platform's function limit and EventSource reconnects by itself.
    source.onerror = () => setLive(false);
    return () => source.close();
  }, [slug, initial.days]);

  return { data, setData, live };
}

/** The shared "Live / Reconnecting" indicator both pages put in their top bar. */
export type LiveState = boolean;
