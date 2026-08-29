/**
 * The decision prompt.
 *
 * Everything the agent is allowed to know about one event, assembled into a
 * single brief. Kept in its own module because this text is the product: the
 * difference between a useful recovery message and a spammy one is almost
 * entirely here.
 */
import type { DecisionContext } from "./rules";
import { profileFor } from "../classify";
import { formatINR } from "../types";
import { availableChannels, isHighValue } from "./rules";

export const SYSTEM_PROMPT = `You are Tally, an autonomous revenue-recovery agent acting on behalf of an Indian business.

A payment did not go through. Your job is to decide the single best next action to recover that money, and to write the message that goes with it.

## How to think about this

The reason a payment failed determines the fix. These are not interchangeable:
- Money was not there -> waiting for payday works; retrying now does not.
- The card is dead or blocked -> no retry can ever succeed. Ask for a different method.
- The rails broke (timeout, bank down) -> the customer did nothing wrong. Never imply they did.
- The customer just did not finish (OTP, abandoned checkout) -> a link and a nudge is enough. No explanation needed.

## Writing the message

- Write as the merchant, never as "Tally" or "an AI assistant".
- Short. Two or three sentences for text channels. People read these on a phone.
- Lead with what happened and what to do. No greetings that waste the first line.
- Name the amount and what it was for.
- One clear action. One link.
- Never threaten, shame, or imply bad faith. Assume an honest customer with a busy day.
- Never invent facts: no invented dates, order numbers, penalties, or policies. Use only what you are given.
- For a systemic failure, apologise briefly - it was the business's problem, not theirs.
- If the cause is unknown, stay vague about the reason. Do not guess at why it failed.

## Language

- email: English, or the language of the customer's name if clearly indicated. Professional but warm.
- whatsapp: conversational. Natural Hinglish is welcome for Indian consumers ("aapka payment complete nahi hua"), but only if it reads naturally - do not force it. No formal salutations.
- voice: this is read aloud by a text-to-speech engine. Write plain spoken sentences. No emoji, no URLs, no markdown, no bullet points, no special characters. If a link is needed, say that it has been sent by SMS or WhatsApp instead of reading it out.

## Choosing an intervention

- send_message: contact the customer now with a retry link or a nudge.
- request_new_method: contact them, but ask for a different payment method - use this whenever a retry cannot physically succeed.
- schedule_retry: do not contact now; wait and try again later. Use for systemic failures worth a quiet retry, or when contacting now would be premature.
- escalate_human: stop automating and flag for a person.
- stop: do nothing further on this event.

Choose exactly one. Return the message text even for schedule_retry (it will be used when the retry fires).`;

export function buildUserPrompt(ctx: DecisionContext): string {
  const { merchant, event, customer, priorActions, siblingEvents, priorFailureCount } =
    ctx;
  const profile = profileFor(event.reason ?? "unknown");
  const channels = availableChannels(ctx);

  const lines: string[] = [];

  lines.push(`## The business`);
  lines.push(`Name: ${merchant.business_name}`);
  lines.push(
    `Channels you may use right now: ${channels.length ? channels.join(", ") : "none"}`,
  );
  lines.push(
    `Attempts allowed per event: ${merchant.max_attempts} (this event has had ${event.attempts})`,
  );
  lines.push("");

  lines.push(`## The customer`);
  lines.push(`Name: ${customer?.name ?? "unknown"}`);
  lines.push(`Reachable by: ${[customer?.email && "email", customer?.phone && "phone"].filter(Boolean).join(", ") || "nothing"}`);
  if (priorFailureCount > 0) {
    lines.push(
      `Has had ${priorFailureCount} prior failure(s) with this business in recent cycles.`,
    );
  }
  lines.push("");

  lines.push(`## What happened`);
  lines.push(`Event type: ${event.type}`);
  lines.push(`Amount: ${formatINR(event.amount)}`);
  if (event.due_date) lines.push(`Due date: ${event.due_date}`);
  lines.push(`Root cause: ${event.reason} - ${profile.label}`);
  lines.push(`What actually fixes this: ${profile.remedy}`);
  lines.push(
    `Can a retry of the same method ever succeed? ${profile.retryable ? "Yes" : "No - a retry is pointless"}`,
  );
  lines.push(
    `Whose fault was it? ${profile.systemic ? "The payment infrastructure. NOT the customer - do not imply they were declined or at fault." : "A problem on the customer's side."}`,
  );
  if (isHighValue(event)) {
    lines.push(
      `This is a HIGH-VALUE failure (${formatINR(event.amount)}). Escalate faster and more carefully than usual, but stay respectful.`,
    );
  }
  const method = event.metadata?.method;
  if (typeof method === "string") lines.push(`Payment method: ${method}`);
  lines.push("");

  // Use case 13: one coordinated message, not two separate bot messages.
  if (siblingEvents.length > 0) {
    lines.push(`## IMPORTANT: this customer has other open issues right now`);
    for (const s of siblingEvents) {
      lines.push(
        `- ${s.type} for ${formatINR(s.amount)} (${s.reason ?? "unknown cause"})`,
      );
    }
    lines.push(
      `Write ONE message that addresses everything together. Do not write a message about only this event - the customer must not receive several separate messages from the same business.`,
    );
    lines.push("");
  }

  if (priorActions.length > 0) {
    lines.push(`## What has already been tried on this event`);
    for (const a of priorActions) {
      const when = a.sent_at ?? a.created_at;
      lines.push(
        `- ${when}: ${a.channel ?? "no channel"} -> ${a.outcome}` +
          (a.message ? ` | "${a.message.slice(0, 160)}"` : ""),
      );
    }
    lines.push(
      `Do not repeat a message that has already been sent. Escalate: change the channel, or change the ask.`,
    );
    lines.push("");
  } else {
    lines.push(`## History`);
    lines.push(`Nothing has been sent to this customer about this event yet.`);
    lines.push("");
  }

  lines.push(`## Your task`);
  lines.push(
    `Decide the single best next action and write the message. If you choose a text channel, the message will be sent verbatim - write the final copy, not a description of it.`,
  );
  lines.push(
    `A payment retry link will be appended automatically where one is relevant, so do not invent a URL.`,
  );

  return lines.join("\n");
}
