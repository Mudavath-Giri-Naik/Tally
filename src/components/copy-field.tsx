"use client";

/**
 * A read-only value with a copy button.
 *
 * Webhook URLs and merchant ids are long, exact, and get pasted into another
 * dashboard - selecting one by hand is where a trailing space comes from.
 */
import { useState } from "react";

export function CopyField({
  value,
  label,
}: {
  value: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be refused (an insecure origin, a locked-down
      // browser). The value is on screen and selectable either way, so this
      // is not worth an error state.
    }
  }

  return (
    <div className="copyfield">
      {label && <div className="copyfield__label">{label}</div>}
      <div className="copyfield__row">
        <code>{value}</code>
        <button type="button" className="copyfield__btn" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
