"use client";

/**
 * The hills-and-dashboard scroll reveal.
 *
 * Two phases, not one continuous blend, because "grow, then move" and "grow
 * while moving" read very differently and only the first was asked for:
 *
 *   Phase 1 (first half of the scroll) - the dashboard only grows, from small
 *   to its actual size, top-anchored so the top edge never shifts. The hills
 *   clear away over this same half, so by the time the dashboard finishes
 *   growing it is both fully visible and fully uncovered.
 *
 *   Phase 2 (second half) - growth is already done (scale is pinned at its
 *   final value), and only now does the dashboard move, downward, settling
 *   into place as the rest of the page scrolls past it.
 *
 * The dashboard stays fully opaque throughout in both phases - covering it is
 * the hills' job, done by position, never by dimming the image itself. Plain
 * scroll math, no library: one listener, one 0-1 number, two derived phases.
 */
import { useEffect, useRef, useState } from "react";

export function HeroReveal() {
  const ref = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    function onScroll() {
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const vh = window.innerHeight;
      // 0 while the section is still below the fold, 1 once it has scrolled
      // most of the way through the viewport.
      const raw = (vh - rect.top) / (vh + rect.height * 0.55);
      setProgress(Math.min(1, Math.max(0, raw)));
    }
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  // Phase 1: 0->1 across the first half of the scroll range. Growth and the
  // hills clearing both ride this, so they finish together.
  const growProgress = Math.min(1, progress / 0.5);
  // Phase 2: 0->1 across the second half. Stays at 0 - no movement at all -
  // for the entire first half, which is what makes the two phases feel
  // sequential rather than blended.
  const moveProgress = Math.max(0, Math.min(1, (progress - 0.5) / 0.5));

  return (
    // No max-width here, deliberately: the hills need to reach the actual
    // browser edges, not the content column's edges. The dashboard screenshot
    // gets its own constrained wrapper nested inside instead.
    <div ref={ref} className="relative w-full">
      <div className="relative aspect-[16/10] w-full sm:aspect-[16/9]">
        <div className="absolute inset-0 mx-auto max-w-6xl px-4 sm:px-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/dashboard.png"
            alt="Tally's live recovery dashboard"
            // top is a fixed, non-animated part of its resting position - not
            // the scroll-driven transform below - raised well above its old
            // top-0 spot so a real chunk of it clears the hills immediately,
            // before any scrolling happens at all.
            className="absolute inset-x-2 top-[-26%] w-[calc(100%-1rem)] rounded-xl shadow-2xl border-[8px] border-white/80 sm:inset-x-6 sm:w-[calc(100%-3rem)] sm:rounded-2xl sm:border-[12px] transition-transform duration-500 ease-out"
            style={{
              // Always fully opaque - being hidden is the hills' job, done by
              // sitting on top of it, not by fading the image itself.
              //
              // translateY is the outer operation, scale the inner one: the
              // image grows first (top-anchored, so the top edge never
              // moves), and only the fully-grown result then shifts down.
              // moveProgress is pinned at 0 for the whole growth phase, so
              // there is no downward drift until growth has actually finished.
              transform: `translateY(${moveProgress * 90}px) scale(${0.6 + growProgress * 0.4})`,
              transformOrigin: "top center",
            }}
          />
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/bottom-hills.png"
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 w-screen max-w-none select-none transition-transform duration-500 ease-out"
          style={{
            left: "50%",
            // translateY is a percentage of the image's OWN rendered height,
            // not the container's. -85% at rest lifts it well above its
            // natural bottom-anchored position so it covers most of the
            // dashboard; +115% clears it completely. Tied to growProgress,
            // not raw progress, so the hills finish clearing at the same
            // point the dashboard finishes growing - neither lingers half
            // done while the other phase is still running.
            transform: `translateX(-50%) translateY(${-85 + growProgress * 200}%)`,
          }}
        />
      </div>
    </div>
  );
}
