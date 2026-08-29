/**
 * Channels.
 *
 * Every channel returns the same result shape and never throws for an expected
 * failure (bad number, unverified sandbox, missing config). A channel outage
 * must degrade one event, not crash the worker mid-batch.
 */
export interface SendResult {
  ok: boolean;
  /** Provider-side id, stored in actions.response for traceability. */
  providerId?: string;
  error?: string;
  /** True when the failure is permanent - do not retry this channel. */
  permanent?: boolean;
}

export interface Recipient {
  name: string | null;
  email: string | null;
  phone: string | null;
}

export interface OutboundMessage {
  merchantName: string;
  recipient: Recipient;
  subject: string | null;
  body: string;
  /** Retry link, appended by the channel in its own idiom. */
  link: string | null;
}

export { sendEmail } from "./email";
export { sendWhatsApp } from "./whatsapp";
export { placeVoiceCall } from "./voice";
