/**
 * The agent, answerable to an admin.
 *
 * The rest of the engine decides on its own schedule and inside guardrails
 * written for an unattended run. This is the other mode: a person is looking
 * at one case, asking in their own words, and expecting either an answer or
 * the thing done now.
 *
 * That difference is why an instruction here can override the contact window
 * - a human has just asked for it, at a moment they can see - while it still
 * cannot override an opt-out. One is a scheduling rule the admin owns; the
 * other is the customer's own decision, and no seniority in the dashboard
 * makes it the merchant's to reverse.
 *
 * Every action taken this way is written to the same audit trail as the
 * automated ones, marked source "admin", so the panel reads as one story
 * regardless of who moved it forward.
 */
import { getProvider, type AgentCommand } from "./providers";
import { updateMerchantSettings } from "../merchants";
import { applyAdminOverride, AdminActionError, recordAction, getEvent } from "../events";
import { liveTransport } from "./worker";
import { stripInventedLinks } from "./links";
import { sendEmail, sendWhatsApp, placeVoiceCall } from "../channels";
import type { SendResult } from "../channels";
import { profileFor } from "../classify";
import type { Merchant, Customer, AdminActionId } from "../types";
import {
  ADMIN_ASK_PREFIX,
  ADMIN_REPLY_PREFIX,
  ADMIN_DID_MARKER,
  ADMIN_SENT_MARKER,
} from "../board";
import type { BoardRow, TimelineEntry } from "../board";

export interface AdminChatResult {
  /** What to show the admin. Always present, even when something failed. */
  reply: string;
  /** What was actually carried out, or "none" for a plain answer. */
  action: string;
  performed: boolean;
  /** Short, plain-words failure. Null when nothing went wrong. */
  error: string | null;
  /**
   * The message that actually went out, link and all.
   *
   * Shown in the chat instead of a summary: an admin who said "message them
   * now" is accountable for what the customer received, and "I sent a
   * WhatsApp message" does not tell them what it said.
   */
  sentBody?: string | null;
}

/** The admin actions the chat can reach, mapped to their override ids. */
const OVERRIDE_ACTIONS: Record<string, AdminActionId> = {
  mark_paid: "mark_paid",
  pause_outreach: "pause_outreach",
  resume_outreach: "resume_outreach",
  snooze: "snooze",
  trigger_next_step: "trigger_next_step",
  escalate_human: "escalate_human",
  opt_out: "opt_out",
  reopen_case: "reopen_case",
  write_off: "write_off",
  flag_disputed: "flag_disputed",
};

/**
 * Provider and transport failures in words a merchant can act on.
 *
 * The raw text is kept in the audit trail either way - this is only what
 * gets said in the chat, where "Twilio 63016" answers nothing and "they have
 * not joined the WhatsApp sandbox yet" answers everything.
 */
export function explainFailure(raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes("63016") || s.includes("sandbox")) {
    return "That number has not joined the WhatsApp sandbox yet, so Twilio accepted the message and dropped it.";
  }
  if (s.includes("unverified") || s.includes("not verified")) {
    return "Twilio will only message verified numbers on a trial account.";
  }
  if (s.includes("21211") || s.includes("invalid") && s.includes("number")) {
    return "That phone number is not one the provider will accept.";
  }
  if (s.includes("not configured") || s.includes("missing")) {
    return `${raw} Set it in the environment and try again.`;
  }
  if (s.includes("429") || s.includes("rate limit") || s.includes("quota")) {
    return "The model is rate-limited right now. Give it a moment and ask again.";
  }
  if (s.includes("503") || s.includes("overloaded") || s.includes("high demand")) {
    return "The model is busy right now. Try again in a few seconds.";
  }
  if (s.includes("401") || s.includes("api key") || s.includes("unauthorized")) {
    return "The model rejected the API key, so I could not think about that one.";
  }
  return raw;
}

function systemPrompt(): string {
  return [
    "You are Tally's recovery agent, answering an admin who is looking at one",
    "case in their dashboard. Be brief and concrete - two or three sentences.",
    "",
    "Decide between answering and acting:",
    "- A question about the case gets action 'none' and an answer in `reply`.",
    "- An instruction to do something gets exactly one action, plus a `reply`",
    "  confirming what you did in plain words.",
    "",
    "When sending, write the actual message in `message`, ready to go out",
    "verbatim - warm, short, never blaming the customer for a failure that was",
    "not theirs. For place_call, `message` is the script to read aloud.",
    "",
    "Never write a URL. A real payment link is created and appended for you,",
    "and any link you invent is stripped out before the message is sent.",
    "",
    "For set_contact_window give window_start and window_end as HH:MM, 24-hour.",
    "For snooze give snooze_until as YYYY-MM-DD.",
    "",
    "You may send outside the contact window when the admin explicitly asks for",
    "it now - they can see the clock. You may never message a customer who has",
    "opted out; say so instead and take no action.",
  ].join("\n");
}

function userPrompt(input: {
  merchant: Merchant;
  row: BoardRow;
  customer: Customer | null;
  timeline: TimelineEntry[];
  question: string;
}): string {
  const { merchant, row, customer, timeline, question } = input;
  const profile = profileFor(row.reason);
  const history = timeline
    .slice(-8)
    .map(
      (t) =>
        `- ${t.created_at} ${t.channel ?? "no channel"} ${t.outcome}` +
        `${t.guardrail ? ` [${t.guardrail}]` : ""}` +
        `${t.message ? `: ${t.message.slice(0, 160)}` : ""}`,
    )
    .join("\n");

  return [
    `Business: ${merchant.business_name} (${merchant.timezone})`,
    `Contact window: ${merchant.contact_window_start}-${merchant.contact_window_end}`,
    `Channels on: ${merchant.channels_enabled.join(", ") || "none"}`,
    `Attempt cap: ${merchant.max_attempts}`,
    "",
    `Customer: ${row.customer_name ?? "unknown"}`,
    `Email: ${customer?.email ?? "none"} | Phone: ${customer?.phone ?? "none"}`,
    `Opted out: ${customer?.opted_out ? "YES - must not be contacted" : "no"}`,
    "",
    `Case: ${row.event_type}, ${row.reason} (${row.reason_label})`,
    `What that cause calls for: ${profile.remedy}`,
    `Amount: ${row.amount ?? 0} paise | Status: ${row.status}`,
    `Attempts used: ${row.attempts} of ${row.max_attempts}`,
    `Next attempt: ${row.next_attempt_at ?? "none scheduled"}`,
    row.stop_reason ? `Stopped because: ${row.stop_reason}` : "",
    "",
    history ? `Recent history:\n${history}` : "Nothing has happened yet.",
    "",
    `The admin says: ${question}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Write one side of the chat to the audit trail.
 *
 * Channel-less and outcome "no_action" so it never counts as an attempt or a
 * contact - it is a note on the case, and the panel lifts it back out by its
 * prefix rather than drawing it as a step.
 */
async function recordTurn(
  merchantId: string,
  eventId: string,
  prefix: string,
  text: string,
): Promise<void> {
  try {
    await recordAction({
      eventId,
      merchantId,
      channel: null,
      message: `${prefix}${text}`,
      outcome: "no_action",
      decision: {
        root_cause: "unknown",
        intervention: "stop",
        channel: null,
        rationale: "Admin conversation about this case.",
        source: "admin",
        guardrail: "admin_chat",
      },
    });
  } catch (err) {
    // The conversation is worth keeping but not worth failing the answer for.
    console.error("[ask] could not record chat turn", err);
  }
}

/** Send on one channel now, and record it as an admin-initiated action. */
async function sendNow(
  channel: "email" | "whatsapp" | "voice",
  input: { merchant: Merchant; row: BoardRow; customer: Customer | null; body: string },
): Promise<{ ok: boolean; error: string | null; sentBody: string | null }> {
  const { merchant, row, customer, body } = input;

  if (customer?.opted_out) {
    return {
      ok: false,
      error: "This customer has opted out, so nothing can be sent to them.",
      sentBody: null,
    };
  }
  if (!merchant.channels_enabled.includes(channel)) {
    return { ok: false, error: `${channel} is switched off for this business.`, sentBody: null };
  }
  const to = channel === "email" ? customer?.email : customer?.phone;
  if (!to) {
    return {
      ok: false,
      error: `No ${channel === "email" ? "email address" : "phone number"} on file for this customer.`,
      sentBody: null,
    };
  }

  // The same real Razorpay link the worker would have attached. Without it an
  // admin-triggered send had nothing to link to, which is exactly when a model
  // invents one - so the link is fetched first, and then anything in the body
  // that is not it is stripped out.
  let link: string | null = null;
  try {
    const event = await getEvent(merchant.id, row.event_id);
    if (event) {
      link = await liveTransport.createLink(merchant, event, {
        name: customer?.name ?? null,
        email: customer?.email ?? null,
        phone: customer?.phone ?? null,
      });
    }
  } catch {
    // A missing link is a degraded message, not a failed one - same call the
    // worker makes. The stripping below then removes any invented stand-in.
    link = null;
  }

  const safeBody = stripInventedLinks(body, link);

  const message = {
    merchantName: merchant.business_name,
    recipient: {
      name: customer?.name ?? null,
      email: customer?.email ?? null,
      phone: customer?.phone ?? null,
    },
    subject: channel === "email" ? `About your payment to ${merchant.business_name}` : null,
    body: safeBody,
    link,
  };

  let result: SendResult;
  try {
    result =
      channel === "email"
        ? await sendEmail(message)
        : channel === "whatsapp"
          ? await sendWhatsApp(message)
          : await placeVoiceCall(message);
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // Recorded either way. A send that failed is part of the story of the case,
  // and the panel's failure card is built from exactly this row.
  await recordAction({
    eventId: row.event_id,
    merchantId: merchant.id,
    channel,
    message: safeBody,
    outcome: result.ok ? "sent" : "failed",
    response: result.ok ? (result.providerId ?? null) : (result.error ?? null),
    sentAt: result.ok ? new Date().toISOString() : null,
    decision: {
      root_cause: row.reason,
      intervention: "send_message",
      channel,
      rationale: "Sent immediately at an admin's instruction from the case panel.",
      source: "admin",
      guardrail: "admin_direct_send",
    },
  });

  return {
    ok: result.ok,
    error: result.ok ? null : explainFailure(result.error ?? "The provider refused it."),
    sentBody: link ? `${safeBody}

${link}` : safeBody,
  };
}

/** Interpret what the admin asked, carry it out, and say what happened. */
export async function askAgent(input: {
  merchant: Merchant;
  row: BoardRow;
  customer: Customer | null;
  timeline: TimelineEntry[];
  question: string;
}): Promise<AdminChatResult> {
  // Written before the model is called, so a question survives a provider
  // that fails to answer it.
  await recordTurn(
    input.merchant.id,
    input.row.event_id,
    ADMIN_ASK_PREFIX,
    input.question,
  );

  const result = await respond(input);

  // The reply, then what it did, then what the customer actually received -
  // all in the one stored turn, so a refresh shows the whole exchange rather
  // than the agreeable half of it.
  let stored = result.error ? `${result.reply} (${result.error})` : result.reply;
  if (result.performed && result.action !== "none") {
    stored += `${ADMIN_DID_MARKER}${result.action}`;
  }
  if (result.sentBody) {
    stored += `${ADMIN_SENT_MARKER}${result.sentBody}`;
  }
  await recordTurn(input.merchant.id, input.row.event_id, ADMIN_REPLY_PREFIX, stored);
  return result;
}

async function respond(input: {
  merchant: Merchant;
  row: BoardRow;
  customer: Customer | null;
  timeline: TimelineEntry[];
  question: string;
}): Promise<AdminChatResult> {
  const provider = await getProvider();
  if (!provider) {
    return {
      reply:
        "No model is configured, so I can only do what the buttons do. Set ANTHROPIC_API_KEY or GEMINI_API_KEY to talk to me here.",
      action: "none",
      performed: false,
      error: null,
    };
  }

  let command: AgentCommand;
  try {
    command = await provider.command(systemPrompt(), userPrompt(input));
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return {
      reply: "I could not think that one through.",
      action: "none",
      performed: false,
      error: explainFailure(raw),
    };
  }

  const { merchant, row, customer } = input;

  try {
    switch (command.action) {
      case "none":
        return { reply: command.reply, action: "none", performed: false, error: null };

      case "send_whatsapp":
      case "send_email":
      case "place_call": {
        const channel =
          command.action === "send_whatsapp"
            ? "whatsapp"
            : command.action === "send_email"
              ? "email"
              : "voice";
        const body = command.message?.trim();
        if (!body) {
          return {
            reply: command.reply,
            action: command.action,
            performed: false,
            error: "I did not have a message to send. Tell me what to say.",
          };
        }
        const sent = await sendNow(channel, { merchant, row, customer, body });
        return {
          reply: command.reply,
          action: command.action,
          performed: sent.ok,
          error: sent.error,
          sentBody: sent.ok ? sent.sentBody : null,
        };
      }

      case "set_contact_window": {
        const start = command.window_start?.trim();
        const end = command.window_end?.trim();
        if (!start || !end || !/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) {
          return {
            reply: command.reply,
            action: command.action,
            performed: false,
            error: "I need both a start and an end time, like 09:00 to 21:00.",
          };
        }
        await updateMerchantSettings(merchant.id, {
          contact_window_start: `${start}:00`,
          contact_window_end: `${end}:00`,
        });
        return { reply: command.reply, action: command.action, performed: true, error: null };
      }

      default: {
        const overrideId = OVERRIDE_ACTIONS[command.action];
        if (!overrideId) {
          return {
            reply: command.reply,
            action: command.action,
            performed: false,
            error: "I do not know how to do that one.",
          };
        }
        await applyAdminOverride({
          merchantId: merchant.id,
          eventId: row.event_id,
          action: overrideId,
          reasonText: command.reason ?? "Asked for in the case panel.",
          snoozeUntil: command.snooze_until ? `${command.snooze_until}T09:00:00Z` : null,
        });
        return { reply: command.reply, action: command.action, performed: true, error: null };
      }
    }
  } catch (err) {
    // An override refused because the case is in the wrong state is a normal
    // answer, not a crash - it says so and the chat repeats it as-is.
    const raw =
      err instanceof AdminActionError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    return {
      reply: command.reply,
      action: command.action,
      performed: false,
      error: explainFailure(raw),
    };
  }
}
