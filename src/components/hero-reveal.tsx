"use client";

/**
 * The hills-and-dashboard scroll reveal.
 *
 * The dashboard screenshot sits tucked behind the hills at rest; scrolling it
 * into view lifts the hills slightly and brings the dashboard up and into
 * focus underneath them - a curtain opening, not a fade. Plain scroll math
 * rather than a library: one listener, one number, two transforms.
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

  return (
    <div ref={ref} className="relative mx-auto w-full max-w-6xl px-4 sm:px-6">
      <div className="relative aspect-[16/10] w-full sm:aspect-[16/9]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/dashboard.png"
          alt="Tally's live recovery dashboard"
          className="absolute inset-x-2 top-0 rounded-xl shadow-2xl ring-1 ring-black/10 sm:inset-x-6 sm:rounded-2xl"
          style={{
            transform: `translateY(${(1 - progress) * 34}px) scale(${0.95 + progress * 0.05})`,
            opacity: 0.55 + progress * 0.45,
            transition: "opacity 60ms linear",
          }}
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/hills.png"
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 w-full select-none"
          style={{ transform: `translateY(${progress * 46}px)` }}
        />
      </div>
    </div>
  );
}
