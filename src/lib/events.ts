/**
 * Event and action repository.
 *
 * Every function here takes or derives a merchant_id and scopes its query by
 * it. That is the tenant boundary - the service-role key does not enforce one,
 * so this module does.
 */
import { db } from "./supabase";
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

/**
 * A payment succeeded. Close whatever open event it was chasing.
 *
 * This is how "money recovered" becomes a measured number rather than an
 * assumption: an event only counts as recovered when Razorpay tells us the
 * customer actually paid, not when Tally sent a message.
 */
export async function markRecoveredByReference(
  merchantId: string,
  refs: { orderId?: string | null; subscriptionId?: string | null },
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
  return recovered;
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
