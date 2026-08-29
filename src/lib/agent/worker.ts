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
import { createRetryLink, retryLinkReference } from "../razorpay";
import { profileFor } from "../classify";
import { decide } from "./decide";
import { preflight, type DecisionContext } from "./rules";
import { sendEmail, sendWhatsApp, placeVoiceCall } from "../channels";
import type { SendResult, OutboundMessage } from "../channels";
import type { Merchant, RecoveryEvent, Channel } from "../types";

/**
 * Outbound side-effects, injectable.
 *
 * The worker's job is deciding and recording; actually reaching Twilio,
 * Resend and Razorpay is a detail it delegates. Keeping that behind an
 * interface means the pipeline can be exercised end to end against a real
 * database without sending anyone a message or creating a live payment link.
 */
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

    const customer = await getCustomer(event.customer_id);
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
      now: new Date(),
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
          new Date(Date.now() + 72 * 3600_000),
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

    const result = await transport.dispatch(decision.channel!, {
      merchantName: merchant.business_name,
      recipient,
      subject: decision.subject,
      body: decision.message,
      link,
    });

    const attempts = event.attempts + 1;

    await recordAction({
      eventId: event.id,
      merchantId: merchant.id,
      channel: decision.channel,
      message: decision.message,
      outcome: result.ok ? "sent" : "failed",
      response: result.ok ? (result.providerId ?? null) : (result.error ?? null),
      sentAt: result.ok ? new Date().toISOString() : null,
      decision,
    });

    if (result.ok) {
      report.sent++;
      if (siblingEvents.length > 0) {
        await suppressSiblings(
          siblingEvents,
          event.id,
          merchant.id,
          new Date(Date.now() + 72 * 3600_000),
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
        await requeueFor(event.id, new Date(Date.now() + 60_000), event.attempts);
      } else {
        await requeueFor(event.id, new Date(Date.now() + 15 * 60_000), attempts);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    report.failed++;
    report.errors.push({ eventId: event.id, error: message });
    console.error("[worker] event failed", { event: event.id, err });
    try {
      // Put it back rather than leaving it stuck in `processing`.
      await requeueFor(event.id, new Date(Date.now() + 5 * 60_000), event.attempts);
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
  } = {},
): Promise<WorkerReport> {
  const started = Date.now();
  const workerId = opts.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
  const batchSize = opts.batchSize ?? 20;
  const transport = opts.transport ?? liveTransport;

  const report: WorkerReport = {
    workerId,
    claimed: 0,
    reclaimed: 0,
    sent: 0,
    scheduled: 0,
    stopped: 0,
    escalated: 0,
    failed: 0,
    durationMs: 0,
    errors: [],
  };

  // Rescue anything a previous worker died holding.
  try {
    report.reclaimed = (await reclaimStaleEvents(300)).length;
  } catch (err) {
    console.error("[worker] reclaim failed", err);
  }

  const claimed = await claimEvents(workerId, batchSize);
  report.claimed = claimed.length;

  // Events covered by another event's coordinated message, within this batch.
  const suppressed = new Set<string>();

  // Sequential on purpose. These calls hit rate-limited third parties, and a
  // burst of parallel sends is how you get throttled by Twilio mid-batch.
  for (const event of claimed) {
    await processEvent(event, report, transport, suppressed);
  }

  report.durationMs = Date.now() - started;
  return report;
}
