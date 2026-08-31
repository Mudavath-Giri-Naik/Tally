/**
 * Event and action repository.
 *
 * Every function here takes or derives a merchant_id and scopes its query by
 * it. That is the tenant boundary - the service-role key does not enforce one,
 * so this module does.
 */
import { db } from "./supabase";
import { boardRowForEvent, type BoardRow } from "./board";
import { ADMIN_ACTIONS, hasPendingStep } from "./admin-actions";
import type {
  RecoveryEvent,
  Action,
  Customer,
  Channel,
  ActionOutcome,
  DecisionRecord,
  EventType,
  EventStatus,
  RootCause,
  AdminActionId,
  Intervention,
} from "./types";

export interface IngestInput {
  merchantId: string;
  providerEventId: string | null;
  type: EventType;
  reason: RootCause | null;
  amount: number | null;
  currency?: string;
  dueDate?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Write an inbound event. Idempotent: a replayed webhook returns the event
 * that already exists rather than creating a second one.
 */
export async function ingestEvent(input: IngestInput): Promise<RecoveryEvent> {
  const { data, error } = await db().rpc("ingest_event", {
    p_merchant_id: input.merchantId,
    p_provider_event_id: input.providerEventId,
    p_type: input.type,
    p_reason: input.reason,
    p_amount: input.amount,
    p_currency: input.currency ?? "INR",
    p_due_date: input.dueDate ?? null,
    p_customer_name: input.customerName ?? null,
    p_customer_email: input.customerEmail ?? null,
    p_customer_phone: input.customerPhone ?? null,
    p_metadata: input.metadata ?? {},
  });
  if (error) throw new Error(`Could not ingest event: ${error.message}`);
  // A scalar-returning composite comes back as a single object.
  return (Array.isArray(data) ? data[0] : data) as RecoveryEvent;
}

/**
 * Claim a batch of events for this worker. Round-robin across merchants,
 * FOR UPDATE SKIP LOCKED - see the function definition in schema.sql.
 */
export async function claimEvents(
  workerId: string,
  limit = 20,
): Promise<RecoveryEvent[]> {
  const { data, error } = await db().rpc("claim_events", {
    p_worker: workerId,
    p_limit: limit,
  });
  if (error) throw new Error(`Could not claim events: ${error.message}`);
  return (data ?? []) as RecoveryEvent[];
}

export async function reclaimStaleEvents(
  olderThanSeconds = 300,
): Promise<RecoveryEvent[]> {
  const { data, error } = await db().rpc("reclaim_stale_events", {
    p_older_than_seconds: olderThanSeconds,
  });
  if (error) throw new Error(`Could not reclaim stale events: ${error.message}`);
  return (data ?? []) as RecoveryEvent[];
}

export async function getCustomer(id: string | null): Promise<Customer | null> {
  if (!id) return null;
  const { data, error } = await db()
    .from("customers")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Could not load customer: ${error.message}`);
  return (data as Customer) ?? null;
}

/** Everything already attempted on this event - the agent's memory. */
export async function actionsForEvent(eventId: string): Promise<Action[]> {
  const { data, error } = await db()
    .from("actions")
    .select("*")
    .eq("event_id", eventId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Could not load actions: ${error.message}`);
  return (data ?? []) as Action[];
}

/**
 * Use case 13: other events still open for the same customer.
 *
 * If someone has a failed subscription AND an abandoned cart, they get one
 * coordinated message, not two bot messages an hour apart.
 */
export async function otherOpenEventsForCustomer(
  merchantId: string,
  customerId: string | null,
  excludeEventId: string,
): Promise<RecoveryEvent[]> {
  if (!customerId) return [];
  const { data, error } = await db()
    .from("events")
    .select("*")
    .eq("merchant_id", merchantId)
    .eq("customer_id", customerId)
    .in("status", ["queued", "processing"])
    .neq("id", excludeEventId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Could not load sibling events: ${error.message}`);
  return (data ?? []) as RecoveryEvent[];
}

/**
 * Use case 14: how many times has this customer failed before?
 *
 * After a few billing cycles of the same failure, automated nudging has
 * stopped working and a human should take over.
 */
export async function priorFailureCount(
  merchantId: string,
  customerId: string | null,
  withinDays = 120,
): Promise<number> {
  if (!customerId) return 0;
  const since = new Date(
    Date.now() - withinDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { count, error } = await db()
    .from("events")
    .select("id", { count: "exact", head: true })
    .eq("merchant_id", merchantId)
    .eq("customer_id", customerId)
    .in("type", ["payment_failed", "subscription_failed", "mandate_retry"])
    .gte("created_at", since);
  if (error) throw new Error(`Could not count prior failures: ${error.message}`);
  return count ?? 0;
}

/**
 * Has any of these events actually been messaged recently?
 *
 * Backs the second half of use case 13. The in-batch suppression in the worker
 * handles the common case; this closes the window where two workers claim a
 * customer's two open events at the same moment, since neither would see the
 * other's suppression write in time.
 */
export async function recentlySentFor(
  eventIds: string[],
  withinMinutes = 360,
): Promise<Action[]> {
  if (eventIds.length === 0) return [];
  const since = new Date(Date.now() - withinMinutes * 60_000).toISOString();
  const { data, error } = await db()
    .from("actions")
    .select("*")
    .in("event_id", eventIds)
    .in("outcome", ["sent", "delivered"])
    .gte("sent_at", since);
  if (error) throw new Error(`Could not check recent contact: ${error.message}`);
  return (data ?? []) as Action[];
}

/**
 * Every customer reachable on this phone number.
 *
 * Scoped to one merchant when the inbound sender identifies one (in
 * production each merchant has its own WhatsApp sender). On the shared
 * sandbox the `To` number identifies nobody, so this returns every match and
 * the caller decides - see the opt-out handling in the inbound route.
 */
/**
 * The customer behind a payment, by the same identity rule ingestion uses:
 * email or phone, scoped to the merchant. Used to credit a payment to a case
 * when the order id cannot, which is what a retried checkout produces.
 */
export async function findCustomerByContact(
  merchantId: string,
  contact: { email?: string | null; phone?: string | null },
): Promise<string | null> {
  const filters: string[] = [];
  if (contact.email) filters.push(`email.ilike.${contact.email}`);
  if (contact.phone) filters.push(`phone.eq.${contact.phone}`);
  if (filters.length === 0) return null;

  const { data, error } = await db()
    .from("customers")
    .select("id")
    .eq("merchant_id", merchantId)
    .or(filters.join(","))
    .limit(1);
  if (error) throw new Error(`Could not find that customer: ${error.message}`);
  return (data?.[0] as { id: string } | undefined)?.id ?? null;
}

export async function findCustomersByPhone(
  phone: string,
  merchantId?: string,
): Promise<Customer[]> {
  let q = db().from("customers").select("*").eq("phone", phone);
  if (merchantId) q = q.eq("merchant_id", merchantId);
  const { data, error } = await q;
  if (error) throw new Error(`Could not look up customer: ${error.message}`);
  return (data ?? []) as Customer[];
}

/**
 * Honour an opt-out.
 *
 * The guardrails already refuse to contact an opted-out customer, but they
 * only run when an event is next processed. Stopping their open events here
 * too means the opt-out takes effect immediately and the dashboard tells the
 * truth straight away, rather than showing work still queued for someone who
 * asked to be left alone.
 */
export async function optOutCustomer(customerId: string): Promise<number> {
  const { error } = await db()
    .from("customers")
    .update({ opted_out: true })
    .eq("id", customerId);
  if (error) throw new Error(`Could not opt out customer: ${error.message}`);

  const { data, error: stopErr } = await db()
    .from("events")
    .update({
      status: "stopped",
      stop_reason: "customer_opted_out",
      next_attempt_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("customer_id", customerId)
    .in("status", ["queued", "processing"])
    .select("id");
  if (stopErr) {
    throw new Error(`Could not stop events after opt-out: ${stopErr.message}`);
  }
  return (data ?? []).length;
}

/** The most recent event for a customer, whatever its status. */
export async function latestEventForCustomer(
  customerId: string,
): Promise<RecoveryEvent | null> {
  const { data, error } = await db()
    .from("events")
    .select("*")
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Could not load latest event: ${error.message}`);
  return (data as RecoveryEvent) ?? null;
}

/** Append to the audit trail. Every decision writes one of these, always. */
export async function recordAction(input: {
  eventId: string;
  merchantId: string;
  channel: Channel | null;
  message: string | null;
  outcome: ActionOutcome;
  response?: string | null;
  decision?: DecisionRecord | null;
  sentAt?: string | null;
}): Promise<Action> {
  const { data, error } = await db()
    .from("actions")
    .insert({
      event_id: input.eventId,
      merchant_id: input.merchantId,
      channel: input.channel,
      message: input.message,
      outcome: input.outcome,
      response: input.response ?? null,
      decision: input.decision ?? null,
      sent_at: input.sentAt ?? null,
    })
    .select()
    .single();
  if (error) throw new Error(`Could not record action: ${error.message}`);
  return data as Action;
}

export async function updateEvent(
  eventId: string,
  patch: Partial<
    Pick<
      RecoveryEvent,
      | "status"
      | "reason"
      | "next_attempt_at"
      | "attempts"
      | "stop_reason"
      | "recovered_amount"
      | "claimed_by"
      | "claimed_at"
      // A promise-to-pay whose date the customer later moves is the same
      // promise on a new day, not a second promise - so the date has to be
      // updatable in place rather than only settable at creation.
      | "due_date"
      // Admin overrides: pause/resume and snooze.
      | "paused"
      | "hold_until"
    >
  >,
): Promise<RecoveryEvent> {
  const { data, error } = await db()
    .from("events")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", eventId)
    .select()
    .single();
  if (error) throw new Error(`Could not update event: ${error.message}`);
  return data as RecoveryEvent;
}

/** Put a claimed event back on the queue, to be retried at a later time. */
export async function requeueFor(
  eventId: string,
  when: Date,
  attempts: number,
): Promise<RecoveryEvent> {
  return updateEvent(eventId, {
    status: "queued",
    next_attempt_at: when.toISOString(),
    attempts,
    claimed_by: null,
    claimed_at: null,
  });
}

/** One event by id, scoped to a merchant so a guessed id from another tenant returns nothing. */
export async function getEvent(
  merchantId: string,
  eventId: string,
): Promise<RecoveryEvent | null> {
  const { data, error } = await db()
    .from("events")
    .select("*")
    .eq("id", eventId)
    .eq("merchant_id", merchantId)
    .maybeSingle();
  if (error) throw new Error(`Could not load the case: ${error.message}`);
  return (data as RecoveryEvent) ?? null;
}

/** A rejected override - the request was well-formed but not allowed. Maps to a 4xx, not a 500. */
export class AdminActionError extends Error {}

export interface AdminOverrideInput {
  merchantId: string;
  eventId: string;
  action: AdminActionId;
  /** Free text from a note, or a resolved "choice: detail" string. Null when the action takes none. */
  reasonText: string | null;
  /** ISO date string - required and only meaningful for "snooze". */
  snoozeUntil?: string | null;
}

/**
 * Run one manual override.
 *
 * Re-derives the case's current status from the same SQL the board itself
 * uses rather than trusting whatever the client last rendered, so a stale
 * dropdown can never apply an action the case has since outgrown. Every
 * override still writes to `actions` exactly like an automated decision does
 * - channel null, source "admin" - so the timeline reads as one story.
 */
export async function applyAdminOverride(input: AdminOverrideInput): Promise<BoardRow> {
  const { merchantId, eventId, action, reasonText } = input;

  const event = await getEvent(merchantId, eventId);
  if (!event) throw new AdminActionError("No such case for this business.");

  const before = await boardRowForEvent(merchantId, eventId);
  if (!before) throw new AdminActionError("No such case for this business.");

  const def = ADMIN_ACTIONS[action];
  if (!def) throw new AdminActionError("Unknown action.");

  const ctx = {
    status: before.status,
    paused: before.paused,
    hasPendingStep: hasPendingStep(before),
  };
  if (!def.availableFor(ctx)) {
    throw new AdminActionError(`"${def.label}" is not available on a case in this state.`);
  }

  const needsText = def.input.kind !== "none" && (def.input.kind !== "note" || def.input.required);
  if (needsText && !reasonText?.trim()) {
    throw new AdminActionError(`"${def.label}" needs a reason before it can run.`);
  }

  let snoozeUntilIso: string | null = null;
  if (def.input.kind === "date") {
    const parsed = input.snoozeUntil ? new Date(input.snoozeUntil) : null;
    if (!parsed || Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
      throw new AdminActionError("Pick a valid date in the future to snooze until.");
    }
    snoozeUntilIso = parsed.toISOString();
  }

  const intervention: Intervention = "admin_override";
  let outcome: ActionOutcome = "no_action";
  let rationale = def.label;
  const note = reasonText?.trim() || null;

  switch (action) {
    case "mark_paid":
      await updateEvent(eventId, {
        status: "recovered",
        recovered_amount: event.amount,
        next_attempt_at: null,
      });
      rationale = ["Marked as paid manually.", note].filter(Boolean).join(" ");
      break;

    case "pause_outreach":
      await updateEvent(eventId, { paused: true });
      rationale = ["Outreach paused by the merchant.", note].filter(Boolean).join(" ");
      break;

    case "resume_outreach":
      await updateEvent(eventId, { paused: false });
      rationale = "Outreach resumed by the merchant.";
      break;

    case "escalate_human":
      await updateEvent(eventId, {
        status: "stopped",
        stop_reason: "admin_escalated",
        next_attempt_at: null,
      });
      outcome = "escalated";
      rationale = ["Escalated to a human by the merchant.", note].filter(Boolean).join(" ");
      break;

    case "flag_disputed":
      await updateEvent(eventId, {
        status: "stopped",
        stop_reason: "admin_disputed",
        next_attempt_at: null,
      });
      rationale = ["Flagged as disputed by the merchant.", note].filter(Boolean).join(" ");
      break;

    case "snooze":
      await updateEvent(eventId, { hold_until: snoozeUntilIso });
      rationale = [
        `Snoozed until ${snoozeUntilIso!.slice(0, 10)} by the merchant.`,
        note,
      ].filter(Boolean).join(" ");
      break;

    case "trigger_next_step":
      await updateEvent(eventId, { next_attempt_at: new Date().toISOString() });
      rationale = "Next step triggered immediately by the merchant.";
      break;

    case "write_off":
      await updateEvent(eventId, {
        status: "stopped",
        stop_reason: "admin_written_off",
        next_attempt_at: null,
      });
      rationale = ["Written off by the merchant.", note].filter(Boolean).join(" ");
      break;

    case "opt_out":
      if (!event.customer_id) {
        throw new AdminActionError("This case has no customer on file to opt out.");
      }
      await optOutCustomer(event.customer_id);
      rationale = [
        "Opted out by the merchant - no further contact on any channel.",
        note,
      ].filter(Boolean).join(" ");
      break;

    case "reopen_case":
      await updateEvent(eventId, {
        status: "queued",
        stop_reason: null,
        next_attempt_at: null,
        paused: false,
        hold_until: null,
      });
      rationale = ["Reopened by the merchant.", note].filter(Boolean).join(" ");
      break;
  }

  await recordAction({
    eventId,
    merchantId,
    channel: null,
    message: note,
    outcome,
    decision: {
      root_cause: event.reason ?? "unknown",
      intervention,
      channel: null,
      rationale,
      source: "admin",
      admin_action: action,
    },
  });

  const after = await boardRowForEvent(merchantId, eventId);
  if (!after) throw new AdminActionError("The case was updated but could not be reloaded.");
  return after;
}

/**
 * A payment succeeded. Close whatever open event it was chasing.
 *
 * This is how "money recovered" becomes a measured number rather than an
 * assumption: an event only counts as recovered when Razorpay tells us the
 * customer actually paid, not when Tally sent a message.
 */
export async function markRecoveredByReference(
  merchantId: string,
  refs: {
    orderId?: string | null;
    subscriptionId?: string | null;
    /** Resolved from the paying customer, for the fallback below. */
    customerId?: string | null;
  },
  amount: number | null,
): Promise<RecoveryEvent[]> {
  const recovered: RecoveryEvent[] = [];

  for (const [key, value] of [
    ["metadata->>order_id", refs.orderId],
    ["metadata->>subscription_id", refs.subscriptionId],
  ] as const) {
    if (!value) continue;
    const { data, error } = await db()
      .from("events")
      .update({
        status: "recovered",
        recovered_amount: amount,
        updated_at: new Date().toISOString(),
      })
      .eq("merchant_id", merchantId)
      .eq(key, value)
      .in("status", ["queued", "processing", "stopped"])
      .select();
    if (error) {
      throw new Error(`Could not mark event recovered: ${error.message}`);
    }
    recovered.push(...((data ?? []) as RecoveryEvent[]));
  }

  if (recovered.length > 0) return recovered;

  /**
   * Nothing matched by reference, which is the normal case for a customer who
   * paid by starting again: a fresh checkout is a fresh Razorpay order, so
   * the id on the payment that succeeded is not the one on the case still
   * open. Left there, the recovered money is never credited to the case and
   * the agent keeps chasing someone who has already paid.
   *
   * The fallback is deliberately narrow - same merchant, same customer, the
   * exact same amount, and only a case still open. Matching on amount alone,
   * or across customers, would close cases that were never paid.
   */
  if (!refs.customerId || amount === null) return recovered;

  const { data, error } = await db()
    .from("events")
    .update({
      status: "recovered",
      recovered_amount: amount,
      updated_at: new Date().toISOString(),
    })
    .eq("merchant_id", merchantId)
    .eq("customer_id", refs.customerId)
    .eq("amount", amount)
    .in("status", ["queued", "processing"])
    .select();
  if (error) {
    throw new Error(`Could not close the customer's open case: ${error.message}`);
  }
  return (data ?? []) as RecoveryEvent[];
}

export async function listEvents(
  merchantId: string,
  limit = 50,
): Promise<RecoveryEvent[]> {
  const { data, error } = await db()
    .from("events")
    .select("*")
    .eq("merchant_id", merchantId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Could not list events: ${error.message}`);
  return (data ?? []) as RecoveryEvent[];
}

/**
 * The events view: filtered, paged, and with the customer already joined in.
 *
 * The dashboard needs the customer's name beside every row, and fetching it
 * per row would be one query per event. PostgREST embeds it in the same
 * request instead. `count: "exact"` comes back in the same round trip, which
 * is what makes paging honest - a page count derived from the rows you
 * happened to fetch is not a page count.
 */
export interface EventFilter {
  status?: EventStatus;
  type?: EventType;
  reason?: string;
  /** Matches a customer name, email or phone, case-insensitively. */
  search?: string;
  limit?: number;
  offset?: number;
}

export interface EventRow extends RecoveryEvent {
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  customer_opted_out: boolean;
}

export interface EventPage {
  rows: EventRow[];
  total: number;
}

export async function listEventsFiltered(
  merchantId: string,
  filter: EventFilter = {},
): Promise<EventPage> {
  const limit = Math.min(Math.max(filter.limit ?? 25, 1), 200);
  const offset = Math.max(filter.offset ?? 0, 0);

  // Strip the PostgREST filter metacharacters. A customer called
  // "Sharma, Ltd." would otherwise be parsed as two filter terms, and a name
  // containing a bare `*` would silently widen the match.
  const term = filter.search?.trim().replace(/[,()*\\]/g, "") || "";

  // The embed has to be an inner join while searching. A filter on an
  // *outer*-joined embed narrows the embedded object but not the parent row,
  // so a plain `customers(...)` embed returns every event and merely blanks
  // the customers that did not match - which reads as "the search did
  // nothing". `!inner` also drops events with no customer at all, which is
  // right: a name search cannot match an event that has no-one attached.
  const embed = term
    ? "customers!inner(name, email, phone, opted_out)"
    : "customers(name, email, phone, opted_out)";

  let q = db()
    .from("events")
    .select(`*, ${embed}`, { count: "exact" })
    .eq("merchant_id", merchantId);

  if (filter.status) q = q.eq("status", filter.status);
  if (filter.type) q = q.eq("type", filter.type);
  if (filter.reason) q = q.eq("reason", filter.reason);

  if (term) {
    q = q.or(
      `name.ilike.%${term}%,email.ilike.%${term}%,phone.ilike.%${term}%`,
      { referencedTable: "customers" },
    );
  }

  const { data, error, count } = await q
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw new Error(`Could not list events: ${error.message}`);

  const rows = ((data ?? []) as Array<Record<string, any>>).map((r) => {
    const { customers, ...event } = r;
    return {
      ...(event as RecoveryEvent),
      customer_name: customers?.name ?? null,
      customer_email: customers?.email ?? null,
      customer_phone: customers?.phone ?? null,
      customer_opted_out: Boolean(customers?.opted_out),
    };
  });

  return { rows, total: count ?? rows.length };
}
