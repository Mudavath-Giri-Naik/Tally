"use client";

/**
 * Light / dark switch.
 *
 * Light is the default. The page no longer follows prefers-color-scheme on its
 * own, because a merchant showing this to someone should get the same thing
 * every time rather than whatever that machine's OS was set to.
 *
 * The choice is stamped on <html> as data-theme and remembered, and the
 * inline script in the dashboard layout applies it before first paint so the
 * page never flashes the wrong theme.
 */
import { useEffect, useState } from "react";

const KEY = "tally-theme";

export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.dataset.theme === "dark");
  }, []);

  function toggle() {
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    setDark(!dark);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Private browsing, or storage disabled. The choice still applies for
      // this page; it simply is not remembered.
    }
  }

  return (
    <button
      type="button"
      className="themetoggle"
      onClick={toggle}
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      title={dark ? "Light theme" : "Dark theme"}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        {dark ? (
          <>
            <circle cx="8" cy="8" r="3.2" fill="currentColor" />
            {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
              <line
                key={a}
                x1="8"
                y1="1.4"
                x2="8"
                y2="3"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                transform={`rotate(${a} 8 8)`}
              />
            ))}
          </>
        ) : (
          <path
            d="M13.4 9.8A5.8 5.8 0 0 1 6.2 2.6a5.8 5.8 0 1 0 7.2 7.2Z"
            fill="currentColor"
          />
        )}
      </svg>
      <span>{dark ? "Light" : "Dark"}</span>
    </button>
  );
}
