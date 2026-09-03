/**
 * What an attempt costs to send, and when an attempt is not worth making.
 *
 * Recovery is only worth doing if it costs less than it recovers, and until
 * this existed Tally could not say whether it did. A dashboard that reports
 * revenue recovered without reporting what was spent to recover it is showing
 * a merchant half of a subtraction.
 *
 * The rates below are list-price estimates for India, in paise, deliberately
 * rounded up. They are not billing: the provider's invoice is the truth, and
 * these are for the merchant-facing "what did chasing this cost" figure and
 * for the guardrail underneath. Rounding up means the reported cost is a
 * ceiling, which is the safe direction to be wrong in when the number is used
 * to justify the spend.
 */
import type { Channel } from "./types";

/**
 * Per-message cost in paise.
 *
 * Email is effectively free at this volume and is written as 3p rather than 0
 * so it still shows up in a sum - a channel that reports zero cost reads as
 * unmeasured rather than cheap.
 *
 * Voice is a flat minimum-duration estimate. Real calls bill per minute and a
 * recovery call that goes well runs longer than one that goes badly, so the
 * figure a merchant sees here is a floor for voice specifically. Said plainly
 * because the alternative is a number that quietly understates the one
 * channel that can actually run away with money.
 */
export const CHANNEL_COST_PAISE: Record<Channel, number> = {
  email: 3,
  whatsapp: 65,
  voice: 120,
};

/** What one attempt on this channel costs. */
export function costOf(channel: Channel | null): number {
  if (!channel) return 0;
  return CHANNEL_COST_PAISE[channel] ?? 0;
}

/**
 * Below this, a voice call is not worth placing.
 *
 * A call costs roughly forty times a WhatsApp message and is the most
 * intrusive thing this system can do to someone. Spending it to chase ninety
 * rupees is bad economics and worse manners - the customer remembers being
 * phoned about a trivial amount long after the merchant has forgotten
 * recovering it.
 *
 * ₹500 is where a call's cost stops being noise against the amount at stake.
 * Note this is a floor on the *amount*, not a computed ROI: a rule a merchant
 * can predict is worth more than one that is exactly optimal, because this
 * one has to be explainable to the person who got the call.
 */
export const VOICE_MIN_AMOUNT_PAISE = 50_000;

/** Is a voice call proportionate to what is being recovered? */
export function voiceIsProportionate(amount: number | null): boolean {
  // An event with no amount is usually an abandoned cart mid-checkout. There
  // is nothing to weigh the call against, so the cheaper channels handle it.
  if (amount === null) return false;
  return amount >= VOICE_MIN_AMOUNT_PAISE;
}

/** "₹1.20" from 120 paise - for cost figures, which are small and need decimals. */
export function formatCost(paise: number): string {
  return `₹${(paise / 100).toFixed(2)}`;
}
