/**
 * Workflows - the four kinds of recovery Tally runs, and which one a given
 * event belongs to.
 *
 * A merchant enables these at the category level, never per root cause: a
 * B2B wholesaler has no checkout to abandon, and a SaaS business has no
 * invoices to chase. Nine root-cause switches would be the same decision
 * asked nine times, in vocabulary a merchant admin does not think in.
 *
 * Pure data and one mapping function, with no database access and no server
 * imports, so the settings form, the onboarding page, the dashboard and the
 * worker's gate all read the same definition rather than four copies of it.
 */
import type { EventType, RootCause } from "./types";

export type WorkflowId =
  | "checkout_abandonment"
  | "failed_payment"
  | "subscription_autopay"
  | "overdue_invoice";

export const WORKFLOW_IDS: WorkflowId[] = [
  "checkout_abandonment",
  "failed_payment",
  "subscription_autopay",
  "overdue_invoice",
];

export interface WorkflowDef {
  id: WorkflowId;
  label: string;
  /** One line, for a toggle row. What this workflow is, in the merchant's words. */
  summary: string;
  /** The kinds of failure it covers, for the longer explanatory line. */
  covers: string;
}

export const WORKFLOWS: Record<WorkflowId, WorkflowDef> = {
  checkout_abandonment: {
    id: "checkout_abandonment",
    label: "Checkout abandonment recovery",
    summary: "Someone started checkout but never attempted a payment.",
    covers:
      "Carts left before payment was initiated, drop-offs on the payment page, " +
      "and sessions that expired mid-checkout.",
  },
  failed_payment: {
    id: "failed_payment",
    label: "Failed payment recovery",
    summary: "Someone attempted a payment and it was declined.",
    covers:
      "Insufficient funds, expired or blocked cards, OTP and 3DS failures, " +
      "international declines, and bank or gateway timeouts.",
  },
  subscription_autopay: {
    id: "subscription_autopay",
    label: "Subscription & auto-pay recovery",
    summary: "A recurring charge or mandate failed.",
    covers:
      "Auto-debit mandate failures, UPI AutoPay limits set below the charge, " +
      "and repeated declines heading towards involuntary churn.",
  },
  overdue_invoice: {
    id: "overdue_invoice",
    label: "Overdue invoice recovery",
    summary: "A manually issued invoice passed its due date unpaid.",
    covers:
      "Invoices unnoticed, forgotten, disputed, or held up by the customer's " +
      "own cash flow.",
  },
};

export const WORKFLOW_COUNT = WORKFLOW_IDS.length;

/**
 * Which workflow handles this event.
 *
 * The event *type* is the primary discriminator, because the line between
 * the first two workflows is exactly "did a payment attempt happen at all" -
 * a customer who walked away during OTP without a decline is an abandoned
 * checkout, while the same OTP failure on a submitted payment is a decline.
 * The root cause cannot tell those apart; the type can.
 *
 * Returns null for events no toggle governs. Today that is only
 * promise-to-pay: it is raised when a customer commits to a date in
 * conversation, so it belongs to whichever case they were already discussing
 * and is honoured whatever the toggles say - a promise the customer made
 * should not be dropped because a category switch was off.
 */
export function workflowFor(
  type: EventType,
  reason: RootCause | null,
): WorkflowId | null {
  // A mandate cause is auto-pay wherever it surfaces. Razorpay reports some
  // mandate failures as a plain payment.failed, so the type alone would file
  // them under failed payments.
  if (reason === "mandate_revoked" || reason === "mandate_limit_exceeded") {
    return "subscription_autopay";
  }

  switch (type) {
    case "cart_abandoned":
      return "checkout_abandonment";
    case "payment_failed":
      return "failed_payment";
    case "subscription_failed":
    case "mandate_retry":
      return "subscription_autopay";
    case "receivable_overdue":
      return "overdue_invoice";
    case "promise_to_pay":
      return null;
  }
}

/** Is this event's workflow one the merchant has switched on? */
export function workflowEnabled(
  enabled: readonly string[],
  workflow: WorkflowId | null,
): boolean {
  // Not governed by a toggle - see workflowFor.
  if (workflow === null) return true;
  return enabled.includes(workflow);
}

export function isWorkflowId(v: unknown): v is WorkflowId {
  return typeof v === "string" && (WORKFLOW_IDS as string[]).includes(v);
}

/** Keeps a stored or submitted list in the canonical order, and drops junk. */
export function normaliseWorkflows(raw: unknown): WorkflowId[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set(raw.filter(isWorkflowId));
  return WORKFLOW_IDS.filter((id) => seen.has(id));
}

/* ── onboarding: the one question, and what it pre-checks ─────────────────── */

export type BusinessType = "ecommerce" | "saas" | "b2b" | "mixed";

export interface BusinessTypeDef {
  id: BusinessType;
  label: string;
  note: string;
  workflows: WorkflowId[];
}

export const BUSINESS_TYPES: BusinessTypeDef[] = [
  {
    id: "ecommerce",
    label: "E-commerce or retail",
    note: "One-off orders, a checkout, no recurring billing.",
    workflows: ["checkout_abandonment", "failed_payment"],
  },
  {
    id: "saas",
    label: "Subscription SaaS",
    note: "Recurring plans on cards or UPI AutoPay.",
    workflows: ["failed_payment", "subscription_autopay"],
  },
  {
    id: "b2b",
    label: "B2B or wholesale",
    note: "Invoices with payment terms. Most also take card payments.",
    workflows: ["overdue_invoice", "failed_payment"],
  },
  {
    id: "mixed",
    label: "Mixed, or not sure",
    note: "Everything on, so nothing is missed. Narrow it down later.",
    workflows: [...WORKFLOW_IDS],
  },
];

/**
 * A fresh copy every time, deliberately.
 *
 * The caller is a form that will then let someone tick boxes on the result;
 * handing back the array held inside BUSINESS_TYPES would mean editing the
 * preset itself, and the next merchant to pick that business type would get
 * the previous one's edits.
 */
export function workflowsForBusinessType(type: BusinessType): WorkflowId[] {
  const preset = BUSINESS_TYPES.find((b) => b.id === type)?.workflows;
  return preset ? [...preset] : [...WORKFLOW_IDS];
}

/**
 * What a merchant gets when nothing was chosen.
 *
 * All four, deliberately: a merchant who never answered the question is
 * better served by Tally chasing something it need not have than by it
 * silently ignoring a category of real lost revenue.
 */
export const DEFAULT_WORKFLOWS: WorkflowId[] = [...WORKFLOW_IDS];
