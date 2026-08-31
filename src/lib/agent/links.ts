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

/** Phrases that promise a link the message may not actually carry. */
const PROMISES_LINK =
  /\b(link (below|above|here)|below[,]? (to|you can)|using the link|click (the|this) link|payment link (below|above))\b/i;

/**
 * Strip a promise of a link when there is no link to keep it.
 *
 * A message reading "complete your payment using the link below" with nothing
 * appended is worse than one that never mentioned a link: the customer hunts
 * for something that was never sent, and the next nudge references it again.
 * That happened live - the link creation was failing, the copy still promised
 * one, and the follow-up said "using the link above".
 *
 * Only the sentence making the promise is removed. Rewriting the rest would
 * mean inventing copy, which is the model's job and not this file's.
 */
export function dropUnbackedLinkPromise(body: string, link: string | null): string {
  if (link) return body;
  const kept = body
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !PROMISES_LINK.test(sentence));
  const out = kept.join(" ").replace(/\s{2,}/g, " ").trim();
  // If every sentence promised the link, say the true thing instead of nothing.
  return out || "We were not able to generate your payment link just now - we will follow up shortly.";
}

/**
 * Is this message trying to give the customer a link?
 *
 * Either by writing one out, or by promising one. Both mean the same thing to
 * whoever reads it, so both are worth minting a real link for rather than
 * quietly deleting - which is what used to happen to every URL the agent
 * wrote, since the conversation had no link to permit.
 */
export function offersLink(body: string): boolean {
  // A fresh non-global copy: URL_RE carries /g, and .test() on a global regex
  // advances lastIndex, so the same string would answer true, then false, then
  // true - a bug that only shows up on the second call.
  return new RegExp(URL_RE.source, "i").test(body) || PROMISES_LINK.test(body);
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
