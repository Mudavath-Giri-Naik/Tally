"use client";

/**
 * A read-only value with a copy button.
 *
 * Webhook URLs get pasted into another dashboard - selecting one by hand is
 * where a trailing space comes from.
 */
import { useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

export function CopyField({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access can be refused. The value is on screen and
      // selectable either way, so this is not worth an error state.
    }
  }

  return (
    <div className="space-y-2">
      {label && <Label>{label}</Label>}
      <div className="flex items-stretch gap-2">
        <code className="bg-muted flex-1 overflow-x-auto rounded-md border px-3 py-2 font-mono text-sm whitespace-nowrap">
          {value}
        </code>
        <Button variant="outline" onClick={copy} className="shrink-0">
          {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}
