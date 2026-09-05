/**
 * The one payment link for a case.
 *
 * Every caller that needs a link for an event routes through here - the
 * automated worker, an admin's direct send, an admin asking the chat for one,
 * and a customer writing back to ask. Each of those used to mint its own
 * fresh Razorpay link, which meant one case's payment could be scattered
 * across several different link ids, and a payer who typed different contact
 * details at checkout than the ones on file left nothing connecting their
 * payment back to this case at all.
 *
 * The fix is to make a link once and remember it (see events.ts's
 * getCachedPaymentLink/cachePaymentLink), and to stamp the case id into the
 * link's own notes at creation (see createRetryLink) so any later webhook for
 * it - success or failure - can be traced back for certain rather than
 * guessed at.
 */
import { createRetryLink, adminLinkReference } from "../razorpay";
import { razorpayCredentials } from "../merchants";
import { getCachedPaymentLink, cachePaymentLink } from "../events";
import type { Merchant, RecoveryEvent } from "../types";

export async function paymentLinkForEvent(
  merchant: Merchant,
  event: RecoveryEvent | undefined,
  customer: { name: string | null; email: string | null; phone: string | null },
): Promise<{ url: string | null; error: string | null }> {
  if (!event) return { url: null, error: "No case to bill against." };
  if (!event.amount || event.amount <= 0) {
    return { url: null, error: "This case has no amount, so there is nothing to collect." };
  }

  const cached = await getCachedPaymentLink(event.id);
  if (cached) return { url: cached, error: null };

  try {
    const creds = razorpayCredentials(merchant);
    const url = await createRetryLink({
      keyId: creds.keyId,
      keySecret: creds.keySecret,
      amount: event.amount,
      currency: event.currency || "INR",
      customerName: customer.name,
      customerEmail: customer.email,
      customerPhone: customer.phone,
      description: `Payment to ${merchant.business_name}`,
      referenceId: adminLinkReference(event.id),
      eventId: event.id,
    });
    await cachePaymentLink(event.id, url);
    return { url, error: null };
  } catch (err) {
    return { url: null, error: err instanceof Error ? err.message : String(err) };
  }
}
