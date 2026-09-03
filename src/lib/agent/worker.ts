/**
 * The background worker.
 *
 * Claims a batch of events, decides what to do with each, does it, and writes
 * every step to the audit trail. One event failing never stops the batch - the
 * failure is recorded on that event and the worker moves on.
 */
import { randomUUID } from "node:crypto";
import {
  claimEvents,
  reclaimStaleEvents,
  getCustomer,
  actionsForEvent,
  otherOpenEventsForCustomer,
  priorFailureCount,
  recentlySentFor,
  recordAction,
  updateEvent,
  requeueFor,
} from "../events";
import { getMerchant, razorpayCredentials } from "../merchants";
import { db } from "../supabase";
import {
  conversationTurns,
  summariseConversation,
  SUMMARY_PREFIX,
  type ConversationContext,
} from "./converse";
import { menuBlock } from "../menu";
import { createRetryLink, retryLinkReference } from "../razorpay";
import { profileFor } from "../classify";
import { stripInventedLinks, dropUnbackedLinkPromise } from "./links";
import { workflowFor, workflowEnabled, WORKFLOWS } from "../workflows";
import { decide } from "./decide";
import { preflight, type DecisionContext } from "./rules";
import { sendEmail, sendWhatsApp, placeVoiceCall } from "../channels";
import type { SendResult, OutboundMessage } from "../channels";
import type { Merchant, RecoveryEvent, Channel } from "../types";
import { caseContacts, contactFor } from "../types";
import { costOf } from "../costs";

/**
 * Outbound side-effects, injectable.
 *
 * The worker's job is deciding and recording; actually reaching Twilio,
 * Resend and Razorpay is a detail it delegates. Keeping that behind an
 * interface means the pipeline can be exercised end to end against a real
 * database without sending anyone a message or creating a live payment link.
 */
/**
 * Leave this much of the 60s function budget for the summary sweep, or skip it.
 * A skipped sweep is picked up by the next tick five minutes later; a sweep cut
 * off by the platform loses the report for the whole run.
 */
const SUMMARY_BUDGET_START_MS = 30_000;

export interface WorkerTransport {
  dispatch(channel: Channel, msg: OutboundMessage): Promise<SendResult>;
  createLink(
    merchant: Merchant,
    event: RecoveryEvent,
    recipient: { name: string | null; email: string | null; phone: string | null },
  ): Promise<string | null>;
}

export interface WorkerReport {
  workerId: string;
  claimed: number;
  reclaimed: number;
  sent: number;
  scheduled: number;
  stopped: number;
  escalated: number;
  failed: number;
  /** Conversations that went quiet and got a summary written this tick. */
  summarised: number;
  durationMs: number;
  errors: Array<{ eventId: string; error: string }>;
}

/** A retry link only makes sense when there is an amount and a payable cause. */
function shouldAttachLink(event: RecoveryEvent): boolean {
  if (!event.amount || event.amount <= 0) return false;
  const profile = profileFor(event.reason ?? "unknown");
  // Even a non-retryable cause gets a link - the link is a *fresh* payment,
  // which is exactly what "use a different card" means.
  return profile.retryable || event.reason === "card_expired" ||
    event.reason === "card_blocked" || event.reason === "international_declined" ||
    event.reason === "mandate_limit_exceeded";
}

async function buildRetryLink(
  merchant: Merchant,
  event: RecoveryEvent,
  customer: { name: string | null; email: string | null; phone: string | null },
): Promise<string | null> {
  if (!shouldAttachLink(event)) return null;
  try {
    const creds = razorpayCredentials(merchant);
    return await createRetryLink({
      keyId: creds.keyId,
      keySecret: creds.keySecret,
      amount: event.amount!,
      currency: event.currency,
      customerName: customer.name,
      customerEmail: customer.email,
      customerPhone: customer.phone,
      description: `Payment to ${merchant.business_name}`,
      // Unique per attempt, so Razorpay's duplicate-reference rejection makes
      // link creation idempotent if the worker retries this event.
      //
      // Razorpay caps reference_id at 40 characters; see retryLinkReference.
      referenceId: retryLinkReference(event.id, event.attempts),
    });
  } catch (err) {
    // A missing link is a degraded message, not a failed one. Send anyway.
    console.error("[worker] retry link creation failed", {
      event: event.id,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export const liveTransport: WorkerTransport = {
  async dispatch(channel, msg) {
    switch (channel) {
      case "email":
        return sendEmail(msg);
      case "whatsapp":
        return sendWhatsApp(msg);
      case "voice":
        return placeVoiceCall(msg);
    }
  },
  createLink: buildRetryLink,
};

/**
 * Use case 13: a coordinated message covered these sibling events too, so they
 * must not be picked up and messaged separately. Push them out and note why.
 */
async function suppressSiblings(
  siblings: RecoveryEvent[],
  coveringEventId: string,
  merchantId: string,
  until: Date,
): Promise<void> {
  for (const sibling of siblings) {
    await recordAction({
      eventId: sibling.id,
      merchantId,
      channel: null,
      message: null,
      outcome: "skipped",
      decision: {
        root_cause: sibling.reason ?? "unknown",
        intervention: "stop",
        channel: null,
        rationale:
          `Covered by a single coordinated message sent for event ${coveringEventId}. ` +
          `Messaging separately would mean two bot messages to the same person.`,
        source: "guardrail",
        guardrail: "coordinated_with_sibling_event",
      },
    });
    await requeueFor(sibling.id, until, sibling.attempts + 1);
  }
}

/** Process exactly one claimed event. Never throws. */
async function processEvent(
  event: RecoveryEvent,
  report: WorkerReport,
  transport: WorkerTransport,
  suppressed: Set<string>,
  /** This run's clock. Real time in production; a simulated instant when a
   *  batch is stepping through a schedule. Everything this function schedules
   *  is relative to it, so a faked now moves the whole ladder together. */
  now: Date,
): Promise<void> {
  try {
    // A sibling event earlier in this same batch already covered this customer
    // with a coordinated message. Do not message them a second time.
    if (suppressed.has(event.id)) {
      report.scheduled++;
      return;
    }

    const merchant = await getMerchant(event.merchant_id);
    if (!merchant) {
      await updateEvent(event.id, {
        status: "stopped",
        stop_reason: "merchant_missing",
      });
      report.stopped++;
      return;
    }

    // The record says who they are; the case says where to reach them. Every
    // consumer below - the guardrails, the prompt, the retry link and the
    // send itself - reads this one resolved object, so none of them can
    // disagree about the recipient. See contactFor.
    const customer = contactFor(caseContacts(event), await getCustomer(event.customer_id));
    const [priorActions, siblingEvents, failures] = await Promise.all([
      actionsForEvent(event.id),
      otherOpenEventsForCustomer(event.merchant_id, event.customer_id, event.id),
      priorFailureCount(event.merchant_id, event.customer_id),
    ]);

    const ctx: DecisionContext = {
      merchant,
      event,
      customer,
      priorActions,
      siblingEvents,
      priorFailureCount: failures,
      now,
    };

    // ── hard stops, before any tokens are spent ──
    const stop = preflight(ctx);
    if (stop) {
      await recordAction({
        eventId: event.id,
        merchantId: merchant.id,
        channel: null,
        message: null,
        outcome: stop.intervention === "escalate_human" ? "escalated" : "no_action",
        decision: {
          root_cause: event.reason ?? "unknown",
          intervention: stop.intervention,
          channel: null,
          rationale: stop.rationale,
          source: "guardrail",
          guardrail: stop.stopReason,
        },
      });
      await updateEvent(event.id, {
        status: "stopped",
        stop_reason: stop.stopReason,
      });
      if (stop.intervention === "escalate_human") report.escalated++;
      else report.stopped++;
      return;
    }

    // ── is this kind of recovery one the merchant runs at all? ──
    //
    // Deliberately after classification, not before it: detection and
    // root-cause classification run for every event whatever the settings
    // say, so a merchant who has a category switched off can still see what
    // they are choosing not to chase. The gate is only on acting.
    const workflow = workflowFor(event.type, event.reason);
    if (!workflowEnabled(merchant.workflows_enabled ?? [], workflow)) {
      const label = workflow ? WORKFLOWS[workflow].label : "This workflow";
      await recordAction({
        eventId: event.id,
        merchantId: merchant.id,
        channel: null,
        message: null,
        outcome: "skipped",
        decision: {
          root_cause: event.reason ?? "unknown",
          intervention: "stop",
          channel: null,
          rationale:
            `Skipped - ${label} is switched off for this business, so nothing ` +
            `was sent. The failure is still recorded and classified.`,
          source: "guardrail",
          guardrail: "workflow_disabled",
        },
      });
      // Stopped rather than left queued: a queued event would be re-claimed
      // and re-skipped every tick, writing the same audit row forever. Turning
      // the workflow back on does not resurrect it - that is what "changes
      // apply going forward" means - but Reopen case still can, by hand.
      await updateEvent(event.id, {
        status: "stopped",
        stop_reason: "workflow_disabled",
      });
      report.stopped++;
      return;
    }

    // ── the decision ──
    const decision = await decide(ctx);

    if (!decision.send) {
      // Scheduled for later, or a deliberate no-op.
      const outcome =
        decision.intervention === "escalate_human"
          ? "escalated"
          : decision.intervention === "stop"
            ? "no_action"
            : "skipped";

      await recordAction({
        eventId: event.id,
        merchantId: merchant.id,
        channel: decision.channel,
        message: decision.message,
        outcome,
        decision,
      });

      if (decision.intervention === "schedule_retry" && decision.scheduledFor) {
        await requeueFor(event.id, decision.scheduledFor, event.attempts);
        report.scheduled++;
      } else {
        await updateEvent(event.id, {
          status: decision.intervention === "escalate_human" ? "stopped" : "stopped",
          stop_reason:
            decision.intervention === "escalate_human"
              ? "escalated_to_human"
              : "agent_chose_stop",
        });
        if (decision.intervention === "escalate_human") report.escalated++;
        else report.stopped++;
      }
      return;
    }

    // ── act ──
    // Cross-worker guard for use case 13: if another worker just messaged this
    // customer about a different open event, fold this one in behind it rather
    // than sending a second message moments later.
    if (siblingEvents.length > 0) {
      const recent = await recentlySentFor(
        siblingEvents.map((s) => s.id),
        360,
      );
      if (recent.length > 0) {
        await recordAction({
          eventId: event.id,
          merchantId: merchant.id,
          channel: null,
          message: null,
          outcome: "skipped",
          decision: {
            root_cause: event.reason ?? "unknown",
            intervention: "stop",
            channel: null,
            rationale:
              "Another open event for this customer was messaged within the last " +
              "six hours. Sending now would mean two messages from the same business.",
            source: "guardrail",
            guardrail: "coordinated_with_sibling_event",
          },
        });
        await requeueFor(
          event.id,
          new Date(now.getTime() + 72 * 3600_000),
          event.attempts + 1,
        );
        report.scheduled++;
        return;
      }
    }

    const recipient = {
      name: customer?.name ?? null,
      email: customer?.email ?? null,
      phone: customer?.phone ?? null,
    };
    const link = await transport.createLink(merchant, event, recipient);

    // The prompt tells the model a real link is appended for it and not to
    // invent one; it does anyway, and a fabricated payment URL sent to someone
    // chasing a failed payment is the worst copy this system can produce - it
    // looks exactly like the phishing it would be mistaken for. Stripped here
    // rather than trusted there.
    const safeMessage = dropUnbackedLinkPromise(
      stripInventedLinks(decision.message, link),
      link,
    );

    // First WhatsApp contact carries the menu, so the customer has a way in
    // that does not require them to compose a sentence. Only the first: a menu
    // repeated on every nudge reads as an automated system talking past them.
    const body =
      decision.channel === "whatsapp" && event.attempts === 0
        ? `${safeMessage}\n\n${menuBlock("root")}`
        : safeMessage;

    const result = await transport.dispatch(decision.channel!, {
      merchantName: merchant.business_name,
      recipient,
      subject: decision.subject,
      body,
      link,
    });

    // What the customer actually received, for the transcript below.
    //
    // The text channels append the link themselves, so recording `safeMessage`
    // filed a message that was missing the one line the customer was meant to
    // act on - and the agent reads these rows back as its own history, so it
    // could not tell which link it had already sent. Voice is excluded because
    // a spoken call does not read a URL out; toSpeakable handles that.
    const sentBody =
      link && decision.channel !== "voice" ? `${body}\n\n${link}` : body;

    const attempts = event.attempts + 1;

    await recordAction({
      eventId: event.id,
      merchantId: merchant.id,
      channel: decision.channel,
      message: sentBody,
      outcome: result.ok ? "sent" : "failed",
      response: result.ok ? (result.providerId ?? null) : (result.error ?? null),
      sentAt: result.ok ? now.toISOString() : null,
      // Only a message that actually went out costs anything. A decision to
      // wait, or a send the provider refused, is free and must not inflate
      // the figure the merchant weighs their recovery against.
      costPaise: result.ok ? costOf(decision.channel) : 0,
      // Where it went, as a fact about this row rather than something the
      // panel works out again later from details that may since have moved.
      decision: {
        ...decision,
        sent_to: decision.channel === "email" ? recipient.email : recipient.phone,
      },
    });

    if (result.ok) {
      report.sent++;
      if (siblingEvents.length > 0) {
        await suppressSiblings(
          siblingEvents,
          event.id,
          merchant.id,
          new Date(now.getTime() + 72 * 3600_000),
        );
        // Keep the rest of this batch from re-messaging the same person.
        for (const sibling of siblingEvents) suppressed.add(sibling.id);
      }
      // Sent, but not yet paid. Come back later unless the cap is reached.
      if (attempts >= merchant.max_attempts) {
        await updateEvent(event.id, {
          status: "stopped",
          attempts,
          stop_reason: "max_attempts_reached",
        });
      } else {
        const { computeNextAttempt } = await import("./rules");
        await requeueFor(
          event.id,
          computeNextAttempt({ ...ctx, event: { ...event, attempts } }),
          attempts,
        );
      }
    } else {
      report.failed++;
      report.errors.push({ eventId: event.id, error: result.error ?? "send failed" });
      if (result.permanent) {
        // This channel will never work for this customer. Try again soon so
        // the agent can pick a different one, rather than burning the cap.
        await requeueFor(event.id, new Date(now.getTime() + 60_000), event.attempts);
      } else {
        await requeueFor(event.id, new Date(now.getTime() + 15 * 60_000), attempts);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    report.failed++;
    report.errors.push({ eventId: event.id, error: message });
    console.error("[worker] event failed", { event: event.id, err });
    try {
      // Put it back rather than leaving it stuck in `processing`.
      await requeueFor(event.id, new Date(now.getTime() + 5 * 60_000), event.attempts);
    } catch {
      // If even that fails, reclaim_stale_events will pick it up later.
    }
  }
}

export async function runWorker(
  opts: {
    workerId?: string;
    batchSize?: number;
    transport?: WorkerTransport;
    /**
     * The instant this run should believe it is.
     *
     * Every schedule this engine writes is in the future - a retry in six
     * hours, a hold until Friday - so the full escalation ladder is
     * unwatchable at wall-clock speed. Passing a simulated now lets a batch
     * step through the whole sequence in seconds against the real scheduling
     * code, guardrails and contact windows included, rather than a mock of
     * them. Omit it in production, where the only honest clock is the real
     * one.
     */
    now?: Date;
  } = {},
): Promise<WorkerReport> {
  const started = Date.now();
  const workerId = opts.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
  const batchSize = opts.batchSize ?? 20;
  const transport = opts.transport ?? liveTransport;
  // The run's clock. Distinct from `started`, which measures how long the run
  // actually took and stays on real time even while this one is faked.
  const now = opts.now ?? new Date();

  const report: WorkerReport = {
    workerId,
    claimed: 0,
    reclaimed: 0,
    sent: 0,
    scheduled: 0,
    stopped: 0,
    escalated: 0,
    failed: 0,
    summarised: 0,
    durationMs: 0,
    errors: [],
  };

  // Rescue anything a previous worker died holding.
  try {
    report.reclaimed = (await reclaimStaleEvents(300)).length;
  } catch (err) {
    console.error("[worker] reclaim failed", err);
  }

  const claimed = await claimEvents(workerId, batchSize, opts.now);
  report.claimed = claimed.length;

  // Events covered by another event's coordinated message, within this batch.
  const suppressed = new Set<string>();

  // Sequential on purpose. These calls hit rate-limited third parties, and a
  // burst of parallel sends is how you get throttled by Twilio mid-batch.
  for (const event of claimed) {
    await processEvent(event, report, transport, suppressed, now);
  }

  // Conversations that have gone quiet get one summary each. Last, because a
  // send is time-sensitive and a summary is not - if the tick runs out of room
  // here, nothing that mattered was skipped.
  //
  // The budget check is the point: a summary costs a model call, the function
  // is capped at 60s on Hobby, and a batch of sends can already have used most
  // of it. Being killed mid-sweep would take the whole tick's report with it,
  // so the sweep only starts if there is plausibly time to finish one.
  const elapsed = Date.now() - started;
  if (elapsed < SUMMARY_BUDGET_START_MS) {
    try {
      report.summarised = await summariseQuietConversations();
    } catch (err) {
      console.error("[worker] conversation summary sweep failed", err);
    }
  } else {
    console.info("[worker] skipping summaries, no time left in this tick", {
      elapsedMs: elapsed,
    });
  }

  report.durationMs = Date.now() - started;
  return report;
}

/** A conversation the sweep has decided is finished. */
interface QuietConversation {
  merchant_id: string;
  customer_id: string;
  anchor_event: string;
  message_count: number;
  first_at: string;
  last_at: string;
}

/**
 * Write one summary per conversation that has stopped moving.
 *
 * The per-turn rows stay where they are; this adds a single line on top so the
 * activity feed reads as "here is what that exchange amounted to" rather than
 * as twenty rows a merchant has to reconstruct the story from.
 */
export async function summariseQuietConversations(
  idleSeconds = 900,
  limit = 10,
): Promise<number> {
  const { data, error } = await db().rpc("conversations_to_summarise", {
    p_idle_seconds: idleSeconds,
    p_limit: limit,
  });
  if (error) {
    throw new Error(`Could not find conversations: ${error.message}`);
  }

  const quiet = (data ?? []) as QuietConversation[];
  let written = 0;

  for (const conv of quiet) {
    try {
      const merchant = await getMerchant(conv.merchant_id);
      const customer = await getCustomer(conv.customer_id);
      if (!merchant || !customer) continue;

      const turns = await conversationTurns(conv.customer_id, 40);
      if (turns.length === 0) continue;

      const ctx: ConversationContext = {
        merchant,
        customer,
        events: [],
        turns,
      };

      const summary = await summariseConversation(ctx);
      // No model configured. Skipping leaves the thread unsummarised and
      // re-eligible next tick, which is better than writing a placeholder
      // that a merchant would read as the actual outcome.
      if (!summary) continue;

      const span = `${conv.message_count} messages, ${new Date(conv.first_at)
        .toISOString()
        .slice(11, 16)}-${new Date(conv.last_at).toISOString().slice(11, 16)} UTC`;

      await recordAction({
        eventId: conv.anchor_event,
        merchantId: conv.merchant_id,
        channel: "whatsapp",
        message: `${SUMMARY_PREFIX}${summary.summary}`,
        outcome: summary.needs_human ? "escalated" : "no_action",
        decision: {
          root_cause: "unknown",
          intervention: summary.needs_human ? "escalate_human" : "stop",
          channel: "whatsapp",
          rationale: `Conversation summary (${span}). ${summary.summary}`,
          source: "agent",
          guardrail: summary.needs_human
            ? "conversation_needs_human"
            : "conversation_summary",
        },
      });
      written++;
    } catch (err) {
      // One bad conversation must not stop the rest, and the turns are still
      // in the trail regardless - a missing summary loses nothing but tidiness.
      console.error("[worker] could not summarise conversation", {
        customer: conv.customer_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return written;
}
