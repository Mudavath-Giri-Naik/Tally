/**
 * WhatsApp, via the Twilio Sandbox.
 *
 * MVP path: every merchant shares Tally's Twilio Sandbox number, and a
 * recipient must have joined the sandbox with its code before they can receive
 * anything. That is a real limitation and the docs page says so.
 *
 * Production path (documented, deliberately not built yet): the merchant
 * connects their own WhatsApp Business sender, and `from` becomes their number
 * rather than the sandbox. Only the `from` resolution below changes.
 */
import twilio from "twilio";
import { optionalEnv, isConfigured } from "../env";
import type { OutboundMessage, SendResult } from "./index";

let client: ReturnType<typeof twilio> | null = null;
function tw(): ReturnType<typeof twilio> {
  if (!client) {
    client = twilio(
      optionalEnv("TWILIO_ACCOUNT_SID"),
      optionalEnv("TWILIO_AUTH_TOKEN"),
    );
  }
  return client;
}

/** Twilio wants `whatsapp:+91...` on both ends. */
function waAddress(e164: string): string {
  return e164.startsWith("whatsapp:") ? e164 : `whatsapp:${e164}`;
}

/**
 * Twilio's error codes for "this recipient cannot receive from us" - retrying
 * these is pointless, so they are marked permanent and the agent escalates to
 * another channel instead of burning attempts.
 */
const PERMANENT_CODES = new Set([
  63003, // channel not found / recipient not in sandbox
  63015, // channel sender not opted in
  63016, // freeform message outside the 24h window
  21211, // invalid 'to' number
  21614, // 'to' is not a valid mobile number
]);

export async function sendWhatsApp(msg: OutboundMessage): Promise<SendResult> {
  if (
    !isConfigured(
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "TWILIO_WHATSAPP_NUMBER",
    )
  ) {
    return {
      ok: false,
      error:
        "WhatsApp channel is not configured - set TWILIO_ACCOUNT_SID, " +
        "TWILIO_AUTH_TOKEN and TWILIO_WHATSAPP_NUMBER.",
      permanent: true,
    };
  }
  if (!msg.recipient.phone) {
    return { ok: false, error: "No phone number for this customer.", permanent: true };
  }

  const body = msg.link ? `${msg.body}\n\n${msg.link}` : msg.body;

  try {
    const result = await tw().messages.create({
      from: waAddress(optionalEnv("TWILIO_WHATSAPP_NUMBER")!),
      to: waAddress(msg.recipient.phone),
      body,
    });
    return { ok: true, providerId: result.sid };
  } catch (err) {
    const code = (err as { code?: number }).code;
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      permanent: code !== undefined && PERMANENT_CODES.has(code),
    };
  }
}
