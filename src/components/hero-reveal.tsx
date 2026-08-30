"use client";

/**
 * The hills-and-dashboard scroll reveal.
 *
 * The dashboard stays fully opaque throughout - whatever of it isn't covered
 * by the hills should look crisp, not faded, so covering it is entirely the
 * hills' job, done by position, never by dimming the thing underneath. At
 * rest the hills sit high enough to genuinely hide the dashboard; scrolling
 * drives two things at once: the dashboard rises into place while the hills
 * travel down past their own height and off the section entirely, so they
 * are gone rather than merely "lower". Plain scroll math, no library: one
 * listener, one 0-1 number, two transforms.
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
            className="absolute inset-x-2 top-0 w-[calc(100%-1rem)] rounded-xl shadow-2xl border-[8px] border-white/80 sm:inset-x-6 sm:w-[calc(100%-3rem)] sm:rounded-2xl sm:border-[12px] transition-transform duration-500 ease-out"
            style={{
              // Always fully opaque - being hidden is the hills' job, done by
              // sitting on top of it, not by fading the image itself. Only
              // position and scale animate, so anything peeking out from
              // behind the hills at any point in the scroll reads crisp.
              transform: `translateY(-100px) scale(${0.60 + progress * 0.40})`,
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
            // dashboard; +115% at full scroll pushes it a full height plus a
            // margin past where it started, clearing the section completely
            // rather than merely sliding to a lower resting spot.
            transform: `translateX(-50%) translateY(${-85 + progress * 200}%)`,
          }}
        />
        {/* Gradient mask to smoothly blend the bottom of the hills into the white section below */}
        <div className="absolute inset-x-0 bottom-0 h-48 bg-gradient-to-t from-white via-white/80 to-transparent pointer-events-none" />
      </div>
    </div>
  );
}
