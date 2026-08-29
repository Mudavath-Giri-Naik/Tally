/**
 * The conversational side of the agent.
 *
 * The recovery agent sends one message and decides one action. This module
 * does the other half: when a customer writes back, it answers them, turn by
 * turn, with their actual payment history in front of it.
 *
 * Design notes worth keeping in mind before changing anything here:
 *
 *  - The reply is sent *after* the webhook has already answered Twilio. A
 *    model call does not fit inside Twilio's timeout, and a slow webhook shows
 *    the customer "an application error occurred".
 *  - Everything the model is told comes from the database. It is given the
 *    facts so it does not have to invent them - grounding is what makes the
 *    replies good, not just safe.
 *  - Two hard limits run before any model call: an opted-out customer is never
 *    replied to, and a customer cannot pull more than a fixed number of
 *    replies a day. Both are checked here rather than trusted to the prompt.
 */
import { db } from "../supabase";
import { getProvider } from "./providers";
import { profileFor } from "../classify";
import { formatINR } from "../types";
import type { Customer, Merchant, RecoveryEvent } from "../types";
import type { AgentReply, AgentSummary } from "./providers";

/**
 * How many auto-replies one customer can draw in a rolling day.
 *
 * Not a conversational limit - a cost and abuse one. Someone who sends two
 * hundred messages should cost two hundred messages' worth of nothing.
 */
export const DEFAULT_DAILY_REPLY_CAP = 25;

export function dailyReplyCap(): number {
  const raw = process.env.TALLY_MAX_AUTO_REPLIES_PER_DAY;
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_DAILY_REPLY_CAP;
}

/** Prefixes that mark who said what, in a table that also holds outbound copy. */
export const INBOUND_PREFIX = "[inbound] ";
export const REPLY_PREFIX = "[reply] ";
export const SUMMARY_PREFIX = "[conversation] ";

export const CONVERSE_SYSTEM_PROMPT = `You are the customer-support voice of an Indian business, replying on WhatsApp to a customer about a payment of theirs that did not go through.

You are having a real conversation. Answer what they actually asked.

## Who you are

- You speak as the business, never as "Tally", never as "an AI assistant", never as a bot.
- Warm, direct, and brief. This is WhatsApp on a phone, not an email. Two or three sentences is usually right.
- Natural Hinglish is welcome where it reads naturally for an Indian consumer. Do not force it.
- No greetings that waste the first line, no sign-offs, no markdown, no bullet lists.

## What you know

You are given this customer's real payment history below: what they owe, why it failed, what has already been sent to them, and what they have already said. That is your source of truth.

- When the answer is in the facts, answer it directly and specifically.
- When something is genuinely not in the facts, say you will check rather than filling the gap with a plausible guess. A customer catching you in an invented order number costs the business more than a short delay.
- Never state that a payment has succeeded unless the facts below say it was recovered. Payment status comes from the payment provider, not from what either of you hopes.

## Handling the awkward ones

- If they are angry, do not match it and do not grovel. Acknowledge the problem in one clause, then be useful.
- If they say they already paid, take it seriously: tell them it will be checked against the provider's records, and set needs_human.
- If they want something you cannot look up or authorise on the spot, say what you can do and set needs_human so a person picks it up.
- If they ask to stop being contacted, tell them they can reply STOP and it takes effect immediately.

## needs_human

Set it to true whenever a person at the business should read this thread afterwards - a claim to have paid, a complaint, a request you could not fully answer, anything about a refund or a dispute. It does not stop you replying; it flags the thread.`;

export const SUMMARY_SYSTEM_PROMPT = `You summarise a finished WhatsApp conversation between an Indian business and a customer about a failed payment.

Write two or three sentences for the business's own activity log - not for the customer, who will never see this.

- What the customer asked or claimed.
- What was told to them.
- Where it was left, and anything still outstanding.

Plain past tense, no preamble, no markdown. Set needs_human when the thread still needs a person to pick it up.`;

/** One line of the transcript, oldest first. */
export interface Turn {
  at: string;
  who: "customer" | "business";
  text: string;
}

export interface ConversationContext {
  merchant: Merchant;
  customer: Customer;
  events: RecoveryEvent[];
  turns: Turn[];
}

/**
 * The facts the model is allowed to speak from, written out in full.
 *
 * Deliberately verbose: an ambiguous brief is what produces a confident wrong
 * answer, and the cost of a few hundred extra tokens is nothing against one
 * invented figure sent to a real customer.
 */
export function buildConversePrompt(ctx: ConversationContext): string {
  const { merchant, customer, events, turns } = ctx;
  const lines: string[] = [];

  lines.push(`## The business`);
  lines.push(`Name: ${merchant.business_name}`);
  lines.push(`You are replying as this business.`);
  lines.push("");

  lines.push(`## The customer`);
  lines.push(`Name: ${customer.name ?? "not on file"}`);
  lines.push(`Phone: ${customer.phone ?? "not on file"}`);
  lines.push(`Email: ${customer.email ?? "not on file"}`);
  lines.push("");

  lines.push(`## Their payments with this business`);
  if (events.length === 0) {
    lines.push(`No payment records. Do not invent any.`);
  }
  for (const e of events) {
    const profile = e.reason ? profileFor(e.reason) : null;
    lines.push(
      `- ${formatINR(e.amount)} · ${e.type.replace(/_/g, " ")} · status: ${e.status}`,
    );
    if (profile) {
      lines.push(`  why it failed: ${profile.label} (${e.reason})`);
      lines.push(`  what fixes it: ${profile.remedy}`);
      lines.push(
        `  can a retry of the same method work? ${profile.retryable ? "yes" : "no - they need a different card or UPI"}`,
      );
    }
    if (e.status === "recovered") {
      lines.push(
        `  this one IS paid - the provider confirmed ${formatINR(e.recovered_amount ?? e.amount)}.`,
      );
    } else {
      lines.push(`  this one is NOT paid as far as the provider has told us.`);
    }
    if (e.due_date) lines.push(`  due: ${e.due_date}`);
    lines.push(`  raised: ${e.created_at.slice(0, 10)}, attempts so far: ${e.attempts}`);
  }
  lines.push("");

  lines.push(`## The conversation so far`);
  lines.push(`Oldest first. The last line is what you are replying to.`);
  if (turns.length === 0) lines.push(`(nothing yet)`);
  for (const t of turns) {
    lines.push(`${t.who === "customer" ? "CUSTOMER" : "YOU"}: ${t.text}`);
  }
  lines.push("");
  lines.push(`Write the next reply.`);

  return lines.join("\n");
}

export function buildSummaryPrompt(ctx: ConversationContext): string {
  const lines = [
    `Business: ${ctx.merchant.business_name}`,
    `Customer: ${ctx.customer.name ?? "unnamed"} (${ctx.customer.phone ?? "no phone"})`,
    ``,
    `Transcript, oldest first:`,
  ];
  for (const t of ctx.turns) {
    lines.push(`${t.who === "customer" ? "CUSTOMER" : "BUSINESS"}: ${t.text}`);
  }
  return lines.join("\n");
}

/**
 * The transcript, reassembled from the audit trail.
 *
 * There is no separate messages table: every turn is already an action row,
 * because the audit trail has to contain the conversation anyway. Reading it
 * back is cheaper than keeping a second copy in sync with it.
 */
export async function conversationTurns(
  customerId: string,
  limit = 20,
): Promise<Turn[]> {
  const { data, error } = await db()
    .from("actions")
    .select("created_at, message, events!inner(customer_id)")
    .eq("events.customer_id", customerId)
    .not("message", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Could not load the conversation: ${error.message}`);

  const turns: Turn[] = [];
  for (const row of (data ?? []) as Array<Record<string, any>>) {
    const message: string = row.message ?? "";
    // A summary is written *about* the conversation; feeding it back in would
    // have the model replying to its own notes.
    if (message.startsWith(SUMMARY_PREFIX)) continue;

    const isInbound = message.startsWith(INBOUND_PREFIX);
    turns.push({
      at: row.created_at,
      who: isInbound ? "customer" : "business",
      text: message
        .replace(INBOUND_PREFIX, "")
        .replace(REPLY_PREFIX, "")
        .trim(),
    });
  }
  return turns.reverse();
}

/** How many replies this customer has already drawn today. */
export async function repliesSentToday(customerId: string): Promise<number> {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const { count, error } = await db()
    .from("actions")
    .select("id, events!inner(customer_id)", { count: "exact", head: true })
    .eq("events.customer_id", customerId)
    .like("message", `${REPLY_PREFIX}%`)
    .gte("created_at", since);
  if (error) throw new Error(`Could not count replies: ${error.message}`);
  return count ?? 0;
}

export type ReplyOutcome =
  | { kind: "reply"; reply: AgentReply }
  | { kind: "skipped"; why: "opted_out" | "rate_limited" | "no_model" };

/**
 * Draft the next turn.
 *
 * Returns rather than sends: the caller owns the transport, so this stays
 * testable without a Twilio account and reusable if a second channel ever
 * grows a conversation.
 */
export async function draftReply(
  ctx: ConversationContext,
): Promise<ReplyOutcome> {
  // Answering someone who has asked to be left alone is the one failure that
  // is not recoverable by apologising for it afterwards.
  if (ctx.customer.opted_out) return { kind: "skipped", why: "opted_out" };

  const cap = dailyReplyCap();
  if (cap === 0) return { kind: "skipped", why: "rate_limited" };
  if ((await repliesSentToday(ctx.customer.id)) >= cap) {
    return { kind: "skipped", why: "rate_limited" };
  }

  const provider = await getProvider();
  // No key configured. Silence is the right failure here - a templated
  // "sorry, I did not understand" is worse than the merchant answering later.
  if (!provider) return { kind: "skipped", why: "no_model" };

  const reply = await provider.reply(
    CONVERSE_SYSTEM_PROMPT,
    buildConversePrompt(ctx),
  );
  return { kind: "reply", reply };
}

export async function summariseConversation(
  ctx: ConversationContext,
): Promise<AgentSummary | null> {
  const provider = await getProvider();
  if (!provider) return null;
  return provider.summarise(SUMMARY_SYSTEM_PROMPT, buildSummaryPrompt(ctx));
}
