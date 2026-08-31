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
// The rotating pool, not the single environment key. This module was the
// last one still calling getProvider(): the worker, the admin chat and the
// settings health check all moved to the pool, so a merchant could watch a
// green "connection works" tick beside a customer conversation that had been
// falling back to a holding line for hours - two different providers, one of
// them with two keys and failover, the other with whatever was in .env.
//
// It also meant the provider and model chosen in Settings applied to every
// part of the agent except the half a customer actually talks to.
import { providerFor } from "./rotating";
import { profileFor } from "../classify";
import { formatINR } from "../types";
import { INBOUND_PREFIX, REPLY_PREFIX, SUMMARY_PREFIX } from "../board";
import type { Customer, Merchant, RecoveryEvent } from "../types";
import type { AgentReply, AgentSummary } from "./providers";

export { INBOUND_PREFIX, REPLY_PREFIX, SUMMARY_PREFIX };

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


export const CONVERSE_SYSTEM_PROMPT = `You are a recovery agent for an Indian business, replying on WhatsApp to a customer whose payment did not go through. Your job is to actually get the money back - not merely to answer questions politely.

## Language

- Reply in **English by default**.
- Mirror the customer: if they write to you in Hindi, Hinglish, Tamil, or anything else, reply in that same language from then on. If they switch, you switch.
- Do not volunteer Hindi or Hinglish to someone who has only written to you in English. Guessing at someone's language is a worse first impression than plain English.

## Who you are

- You speak as the business, never as "Tally", never as "an AI assistant", never as a bot.
- Warm, direct, and brief. This is WhatsApp on a phone, not an email. Two or three sentences is usually right.
- No greetings that waste the first line, no sign-offs, no markdown, no bullet lists.

## What you know

The facts below are your only source of truth: what they owe, why it failed, what has already been sent, and what has already been said. Each payment is numbered and marked either OUTSTANDING or SETTLED.

- Answer from those facts, specifically. Quote the actual amount and the actual reason.
- **If they ask what this is about, what happened, or who you are, explain it properly.** Which business, how much, which order, and why it failed - in plain words, in two or three sentences. "Let me check and come back to you" is not an answer to a question you were already given the answer to. Never stall on something the facts below already tell you.
- If something genuinely is not in the facts, say you will check rather than inventing it.
- Read the conversation history before replying. If you already asked something and they answered, do not ask again. If they already promised a date, refer to that date rather than asking afresh.

## Payment status - the rule you must not break

**A customer telling you they have paid is not evidence that they have paid.** Only the provider confirms payments, and the facts below reflect what the provider has actually confirmed.

- NEVER say "we received your payment", "thank you for paying", or anything that treats an unconfirmed payment as settled - not even if they insist, and not even to be polite.
- If they claim to have paid something the facts still show as OUTSTANDING, believe them *provisionally* and say you will verify. Something like: "Thanks - I can't see it on our side yet. It can take a little time to show. If you have a reference number, send it and I'll get it checked." Then set needs_human.
- Never apologise for the payment having failed as though it were confirmed-paid. It failed; that is the fact.
- If a payment IS marked SETTLED in the facts, you may acknowledge that one - but be precise about which one, and mention any that remain OUTSTANDING.

## Actually recovering the money

You are trying to close this, not just be pleasant. In every reply, move it forward:

- Ask for a specific commitment - a date, or a payment now.
- Offer the payment link when it would help. Say the amount every time.
- If they say "later" with no date, ask which day. A promise without a date is not a promise.
- If they raise an objection - too expensive, did not order it, card issue - address that specific objection, then return to the payment.
- Be persistent without being rude. Never threaten, never shame, never imply bad faith.
- If they are genuinely refusing, or something needs a human decision, stop pushing and set needs_human.

## needs_human

Set it to true whenever a person should read this thread afterwards - a claim to have paid, a complaint, a refund or dispute, a request you could not fully answer, or a customer who is clearly upset. It does not stop you replying; it flags the thread.`;

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
  /**
   * The agent's own note about everything that happened before the turns
   * below - written by the summary sweep once a thread goes quiet.
   *
   * Without this the agent's memory is only as long as MAX_TURNS_IN_CONTEXT:
   * anything older simply vanished, so it would re-ask questions it had
   * already asked and forget commitments already made. This is the compressed
   * version of that lost history.
   */
  earlierSummary?: string | null;
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

  // Split rather than interleaved, and totalled: the agent confirming a
  // payment that was never confirmed traces back to it seeing one settled
  // row in a mixed list and treating the whole account as clear.
  const settled = events.filter((e) => e.status === "recovered");
  const outstanding = events.filter((e) => e.status !== "recovered");
  const owed = outstanding.reduce((sum, e) => sum + (e.amount ?? 0), 0);

  const describe = (e: RecoveryEvent, i: number, label: string) => {
    const profile = e.reason ? profileFor(e.reason) : null;
    lines.push(
      `${label} ${i}. ${formatINR(e.amount)} · ${e.type.replace(/_/g, " ")} · raised ${e.created_at.slice(0, 10)}`,
    );
    if (profile) {
      lines.push(`   why it failed: ${profile.label} (${e.reason})`);
      lines.push(`   what fixes it: ${profile.remedy}`);
      lines.push(
        `   can a retry of the same method work? ${profile.retryable ? "yes" : "no - they need a different card or UPI"}`,
      );
    }
    if (e.due_date) lines.push(`   promised for: ${e.due_date}`);
    lines.push(`   attempts so far: ${e.attempts}`);
  };

  lines.push(`## Their payments with this business`);
  if (events.length === 0) {
    lines.push(`No payment records at all. Do not invent any.`);
  }

  lines.push("");
  lines.push(
    `### OUTSTANDING - the provider has NOT confirmed these. Total still owed: ${formatINR(owed)}`,
  );
  if (outstanding.length === 0) {
    lines.push(`(none - nothing is currently owed)`);
  }
  outstanding.forEach((e, i) => describe(e, i + 1, "OUTSTANDING"));

  lines.push("");
  lines.push(`### SETTLED - the provider confirmed these were actually paid`);
  if (settled.length === 0) {
    lines.push(
      `(none - the provider has confirmed no payment from this customer yet, whatever they may have told you)`,
    );
  }
  settled.forEach((e, i) => describe(e, i + 1, "SETTLED"));
  lines.push("");

  if (ctx.earlierSummary) {
    lines.push(`## Earlier in this conversation`);
    lines.push(
      `Your own note on what happened before the messages below. Treat it as memory, not as something the customer said:`,
    );
    lines.push(ctx.earlierSummary);
    lines.push("");
  }

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
/**
 * How many past turns the model is shown.
 *
 * Bounded on purpose. The prompt grows with the conversation, the reasoning
 * grows with the prompt, and both are charged to a fixed output budget - an
 * unbounded transcript is a reply that works early in a chat and fails later
 * in the same chat.
 */
export const MAX_TURNS_IN_CONTEXT = 12;

export async function conversationTurns(
  customerId: string,
  limit = MAX_TURNS_IN_CONTEXT,
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

/**
 * The most recent summary written about this customer's conversation.
 *
 * Read back deliberately: the turns list is capped, so without this the agent
 * forgets anything older than that cap. The summary is what the sweep wrote
 * precisely so that history survives compression.
 */
export async function latestSummary(customerId: string): Promise<string | null> {
  const { data, error } = await db()
    .from("actions")
    .select("message, events!inner(customer_id)")
    .eq("events.customer_id", customerId)
    .like("message", `${SUMMARY_PREFIX}%`)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) return null;

  const row = (data ?? [])[0] as Record<string, any> | undefined;
  if (!row?.message) return null;
  return String(row.message).slice(SUMMARY_PREFIX.length).trim() || null;
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

/**
 * What goes out when the model cannot be reached at all.
 *
 * Silence is the worse failure. A customer who asks a question and gets
 * nothing back assumes the business is ignoring them; a short honest holding
 * line costs the merchant nothing and keeps the thread alive until a person
 * or the next message picks it up.
 */
export const FALLBACK_MESSAGE =
  "Thanks for writing in - let me check this and come back to you shortly.";

/**
 * The holding line, but grounded in what we already know.
 *
 * The bare version above answers nothing. A customer who writes "what
 * happened and what is this?" and gets "let me check this and come back to
 * you" has been told less than they knew before, by a system holding the
 * whole answer in a database - the amount, the reason it failed, and what
 * fixes it. That is not a model's job to remember; it is a lookup.
 *
 * So when the model cannot be reached, say the facts plainly and still ask
 * for the commitment. It is not a conversation, but it is an answer, and it
 * beats a stall in every case except the one where we truly know nothing -
 * where this returns the stall on purpose.
 */
export function groundedFallback(ctx: ConversationContext): string {
  const { merchant, events } = ctx;
  const outstanding = events.filter((e) => e.status !== "recovered");
  if (outstanding.length === 0) return FALLBACK_MESSAGE;

  const owed = outstanding.reduce((sum, e) => sum + (e.amount ?? 0), 0);
  const what =
    outstanding.length === 1
      ? `a payment of ${formatINR(owed)}`
      : `${outstanding.length} payments totalling ${formatINR(owed)}`;

  const parts = [`This is ${merchant.business_name} about ${what} that did not go through.`];

  // Why it failed, and what to do about it - the two things a customer asking
  // "what is this?" is really asking, both already classified.
  //
  // The label only. `profile.remedy` is written for whoever operates Tally
  // ("retry near a likely salary-credit date"), and sending an internal
  // collection tactic to the person it is a tactic about would be worse than
  // saying nothing - so the customer-facing half is spelled out here instead.
  const newest = outstanding[0];
  const profile = newest?.reason ? profileFor(newest.reason) : null;
  if (profile) {
    parts.push(
      `The reason given was: ${profile.label.toLowerCase()}.` +
        (profile.retryable
          ? " It should go through if you try again."
          : " You will need a different card or UPI to complete it."),
    );
  }

  parts.push("Can you let me know which day you can complete it? Someone here is looking at your message too.");
  return parts.join(" ");
}

/**
 * How long the holding line stays quiet before it may be sent again.
 *
 * Not "never twice in a row": that silenced the customer completely for as
 * long as the model was down, so someone who came back twenty minutes later
 * with a new question got nothing at all. Repeating it within a minute is
 * noise; repeating it after a real gap is just answering the new message.
 */
export const FALLBACK_COOLDOWN_MS = 10 * 60 * 1000;

export type ReplyOutcome =
  | { kind: "reply"; reply: AgentReply }
  | { kind: "fallback"; message: string; error: string }
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

  const provider = await providerFor(ctx.merchant);
  // No key configured at all. Nothing to fall back from, and a merchant who
  // never set a key has not asked for auto-replies.
  if (!provider) return { kind: "skipped", why: "no_model" };

  try {
    const reply = await provider.reply(
      CONVERSE_SYSTEM_PROMPT,
      buildConversePrompt(ctx),
    );
    return { kind: "reply", reply };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);

    const message = groundedFallback(ctx);

    // Do not answer a stall with the same stall seconds later. But do answer
    // again once real time has passed - a customer coming back with a new
    // question after ten minutes is not the same event as them sending two
    // messages in a row.
    const lastFromUs = [...ctx.turns].reverse().find((t) => t.who === "business");
    if (lastFromUs && lastFromUs.text.trim() === message.trim()) {
      const age = Date.now() - Date.parse(lastFromUs.at);
      if (Number.isFinite(age) && age < FALLBACK_COOLDOWN_MS) {
        return { kind: "skipped", why: "no_model" };
      }
    }

    return { kind: "fallback", message, error };
  }
}

export async function summariseConversation(
  ctx: ConversationContext,
): Promise<AgentSummary | null> {
  const provider = await providerFor(ctx.merchant);
  if (!provider) return null;
  return provider.summarise(SUMMARY_SYSTEM_PROMPT, buildSummaryPrompt(ctx));
}
