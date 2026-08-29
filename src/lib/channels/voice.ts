/**
 * Voice, via Twilio.
 *
 * Scripted text-to-speech, spoken in an Indian-English/Hindi voice. TwiML is
 * passed inline rather than fetched from a callback URL, so this works from a
 * local machine with no public tunnel - one less thing to break during a demo.
 *
 * A fully conversational Hinglish agent (ElevenLabs + a media stream) is the
 * upgrade path; this is the version that works end to end first.
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

/** Polly.Aditi handles Hindi and Hinglish far better than the default voice. */
const VOICE = "Polly.Aditi";
const LANGUAGE = "hi-IN";

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * A URL read aloud is unusable. Strip links and markdown before speaking, and
 * tell the customer where the link actually is instead.
 */
export function toSpeakable(body: string, hasLink: boolean): string {
  let spoken = body
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_`#>|]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (hasLink) {
    spoken +=
      " We have also sent you the payment link on WhatsApp and email, so you can complete it there.";
  }
  return spoken;
}

export function buildTwiml(msg: OutboundMessage): string {
  const spoken = toSpeakable(msg.body, msg.link !== null);
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Pause length="1"/>` +
    `<Say voice="${VOICE}" language="${LANGUAGE}">${escapeXml(spoken)}</Say>` +
    `<Pause length="1"/>` +
    `<Say voice="${VOICE}" language="${LANGUAGE}">${escapeXml(
      `Thank you. This call was on behalf of ${msg.merchantName}.`,
    )}</Say>` +
    `</Response>`
  );
}

export async function placeVoiceCall(msg: OutboundMessage): Promise<SendResult> {
  if (
    !isConfigured("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER")
  ) {
    return {
      ok: false,
      error:
        "Voice channel is not configured - set TWILIO_ACCOUNT_SID, " +
        "TWILIO_AUTH_TOKEN and TWILIO_PHONE_NUMBER.",
      permanent: true,
    };
  }
  if (!msg.recipient.phone) {
    return { ok: false, error: "No phone number for this customer.", permanent: true };
  }

  try {
    const call = await tw().calls.create({
      from: optionalEnv("TWILIO_PHONE_NUMBER")!,
      to: msg.recipient.phone,
      twiml: buildTwiml(msg),
      // A recovery call that reaches voicemail is a wasted rupee and an
      // unsettling message - hang up instead.
      machineDetection: "Enable",
      timeout: 25,
    });
    return { ok: true, providerId: call.sid };
  } catch (err) {
    const code = (err as { code?: number }).code;
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      permanent: code === 21211 || code === 21614,
    };
  }
}
