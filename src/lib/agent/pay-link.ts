/**
 * A real payment link for a conversation.
 *
 * The dunning worker mints a link per attempt and the admin chat mints one on
 * request. The half in between - a customer writing back to ask for one - had
 * neither, so the conversational agent was sent out with no link to offer,
 * every URL it wrote was stripped as an invention, and "give me the link" was
 * answered with a message that mentioned a link and carried none.
 *
 * Keyed on the request rather than the attempt, for the same reason the admin
 * one is: a customer asking twice means it, and Razorpay refuses a duplicate
 * reference.
 */
import { createRetryLink, adminLinkReference } from "../razorpay";
import { razorpayCredentials } from "../merchants";
import type { Merchant, Customer, RecoveryEvent } from "../types";

export async function paymentLinkForEvent(
  merchant: Merchant,
  event: RecoveryEvent | undefined,
  customer: Customer,
): Promise<{ url: string | null; error: string | null }> {
  if (!event) return { url: null, error: "No case to bill against." };
  if (!event.amount || event.amount <= 0) {
    return { url: null, error: "This case has no amount, so there is nothing to collect." };
  }
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
    });
    return { url, error: null };
  } catch (err) {
    return { url: null, error: err instanceof Error ? err.message : String(err) };
  }
}
