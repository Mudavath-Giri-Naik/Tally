"use client";

/**
 * The dashboard scroll reveal.
 *
 * Two phases, not one continuous blend, because "grow, then move" and "grow
 * while moving" read very differently and only the first was asked for:
 *
 *   Phase 1 (first half of the scroll) - the dashboard only grows, from small
 *   to its actual size, top-anchored so the top edge never shifts.
 *
 *   Phase 2 (second half) - growth is already done (scale is pinned at its
 *   final value), and only now does the dashboard move, downward, settling
 *   into place as the rest of the page scrolls past it.
 *
 * There used to be a hills image layered in front of the dashboard, covering
 * it at rest and clearing away over phase 1. Removed outright rather than
 * hidden - the dashboard's own grow-then-move animation does not depend on
 * anything having sat in front of it, so nothing else here needed to change.
 *
 * Plain scroll math, no library: one listener, one 0-1 number, two derived
 * phases.
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

  // Phase 1: 0->1 across the first half of the scroll range.
  const growProgress = Math.min(1, progress / 0.5);
  // Phase 2: 0->1 across the second half. Stays at 0 - no movement at all -
  // for the entire first half, which is what makes the two phases feel
  // sequential rather than blended.
  const moveProgress = Math.max(0, Math.min(1, (progress - 0.5) / 0.5));

  return (
    <div ref={ref} className="relative mx-auto w-full max-w-6xl px-4 sm:px-6">
      <div className="relative aspect-[16/10] w-full sm:aspect-[16/9]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/dashboard.png"
          alt="Tally's live recovery dashboard"
          // top is a fixed, non-animated part of its resting position - not
          // the scroll-driven transform below - raised so a real chunk of it
          // is visible immediately, before any scrolling happens at all.
          className="absolute inset-x-2 top-[-26%] w-[calc(100%-1rem)] rounded-xl shadow-2xl border-[8px] border-white/80 sm:inset-x-6 sm:w-[calc(100%-3rem)] sm:rounded-2xl sm:border-[12px] transition-transform duration-500 ease-out"
          style={{
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
    </div>
  );
}
