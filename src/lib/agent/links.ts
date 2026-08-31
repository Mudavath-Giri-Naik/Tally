/**
 * Links in outgoing copy, as a guardrail rather than an instruction.
 *
 * The prompt already tells the model a real payment link is appended for it
 * and not to invent one. It does anyway - "tally.so/pay/retry" and similar
 * plausible-looking inventions - and a fabricated payment URL sent to a
 * customer chasing a failed payment is the worst copy this system can
 * produce: it looks exactly like the phishing it would be mistaken for.
 *
 * So the message is filtered before it is sent. Anything that is not the link
 * Razorpay actually issued for this attempt comes out, on the same principle
 * as the rest of the guardrails - the model proposes the words, code decides
 * what is allowed to reach a customer.
 */

/** Matches bare URLs and the ones models like to wrap in markdown or parens. */
const URL_RE = /\bhttps?:\/\/[^\s<>()[\]{}"']+|\bwww\.[^\s<>()[\]{}"']+/gi;

/**
 * Remove every URL from `body` except `allowed`.
 *
 * The allowed link is compared after trimming a trailing slash, because a
 * model that echoes the real link back sometimes adds or drops one, and
 * dropping the customer's actual payment link over a slash would be worse
 * than the invention this exists to stop.
 */
export function stripInventedLinks(body: string, allowed: string | null): string {
  const permitted = allowed ? normalise(allowed) : null;

  const cleaned = body.replace(URL_RE, (match) => {
    // Trailing sentence punctuation is not part of the URL.
    const trimmed = match.replace(/[.,;:!?]+$/, "");
    const tail = match.slice(trimmed.length);
    if (permitted && normalise(trimmed) === permitted) return match;
    return tail;
  });

  // A removed link usually leaves the scaffolding it sat in - "pay here: ."
  // or a double space. Tidy the obvious cases rather than shipping the seams.
  return cleaned
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/([:>-])\s*([.\n]|$)/g, "$2")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalise(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

/** True when the body still carries a URL that is not the permitted one. */
export function hasInventedLink(body: string, allowed: string | null): boolean {
  const permitted = allowed ? normalise(allowed) : null;
  const found = body.match(URL_RE) ?? [];
  return found.some((m) => {
    const trimmed = m.replace(/[.,;:!?]+$/, "");
    return !permitted || normalise(trimmed) !== permitted;
  });
}
