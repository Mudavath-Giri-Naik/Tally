/**
 * The manual overrides available from the customer table's kebab menu.
 *
 * Pure data and predicates, no icons and no database access, so the exact
 * same rule for "is this action valid on this case" runs in the dropdown
 * (to decide what to show) and in the API route (to decide what to allow) -
 * one definition, not two that could quietly drift apart. Icons are a
 * presentation detail and live with the component that renders the menu.
 */
import type { AdminActionId } from "./types";
import type { BoardStatus } from "./board";

/** What the row looks like as far as an action's availability is concerned. */
export interface AdminActionContext {
  status: BoardStatus;
  paused: boolean;
  /** True when there is a scheduled step still waiting on its delay. */
  hasPendingStep: boolean;
}

export type AdminActionInput =
  | { kind: "none" }
  | { kind: "note"; required: boolean; placeholder: string }
  | { kind: "choice"; required: true; choices: string[]; allowOther: true; placeholder: string }
  | { kind: "date"; required: true; withNote: true };

export interface AdminActionDef {
  id: AdminActionId;
  label: string;
  description: string;
  destructive?: boolean;
  /** The one action that must interrupt with an "are you sure" step. */
  confirm?: boolean;
  input: AdminActionInput;
  availableFor: (ctx: AdminActionContext) => boolean;
}

/** Automation is still nominally running (or pause-able) on these. */
const ACTIVE: BoardStatus[] = ["chasing", "escalated_voice", "needs_human"];
/** The only statuses "Reopen case" is offered on. */
const REOPENABLE: BoardStatus[] = ["stopped", "disputed", "written_off"];

export const ADMIN_ACTION_ORDER: AdminActionId[] = [
  "mark_paid",
  "pause_outreach",
  "resume_outreach",
  "trigger_next_step",
  "snooze",
  "escalate_human",
  "flag_disputed",
  "write_off",
  "opt_out",
  "reopen_case",
];

export const ADMIN_ACTIONS: Record<AdminActionId, AdminActionDef> = {
  mark_paid: {
    id: "mark_paid",
    label: "Mark as paid manually",
    description: "Sets this case to Recovered right away and cancels any pending automated contact.",
    input: { kind: "note", required: false, placeholder: "e.g. paid via bank transfer (optional)" },
    availableFor: (ctx) => ctx.status !== "recovered",
  },
  pause_outreach: {
    id: "pause_outreach",
    label: "Pause outreach",
    description: "Freezes future automated contact until you resume it. The status label does not change.",
    input: { kind: "note", required: false, placeholder: "Reason for pausing (optional)" },
    availableFor: (ctx) => ACTIVE.includes(ctx.status) && !ctx.paused,
  },
  resume_outreach: {
    id: "resume_outreach",
    label: "Resume outreach",
    description: "Lifts the pause - automated contact can fire again.",
    input: { kind: "none" },
    availableFor: (ctx) => ACTIVE.includes(ctx.status) && ctx.paused,
  },
  escalate_human: {
    id: "escalate_human",
    label: "Escalate to human now",
    description: "Sets this case to Needs human immediately and cancels the remaining scheduled steps.",
    input: {
      kind: "choice",
      required: true,
      choices: ["Customer confused", "Negative sentiment", "Complex case"],
      allowOther: true,
      placeholder: "Describe the situation",
    },
    availableFor: (ctx) => ACTIVE.includes(ctx.status) && ctx.status !== "needs_human",
  },
  flag_disputed: {
    id: "flag_disputed",
    label: "Flag as disputed",
    description: "Sets this case to Disputed and suppresses the standard reminder copy.",
    input: { kind: "note", required: true, placeholder: "What is being disputed?" },
    availableFor: (ctx) => ACTIVE.includes(ctx.status),
  },
  snooze: {
    id: "snooze",
    label: "Snooze until a date",
    description: "No automated contact fires before the date you pick.",
    input: { kind: "date", required: true, withNote: true },
    availableFor: (ctx) => ACTIVE.includes(ctx.status),
  },
  trigger_next_step: {
    id: "trigger_next_step",
    label: "Trigger next step now",
    description: "Skips the remaining wait and fires the next step immediately - still through the normal guardrails.",
    input: { kind: "none" },
    availableFor: (ctx) => ACTIVE.includes(ctx.status) && !ctx.paused && ctx.hasPendingStep,
  },
  write_off: {
    id: "write_off",
    label: "Write off / close as uncollectible",
    description: "Sets this case to Written off (excluded from the recovery rate) and cancels future contact.",
    input: {
      kind: "choice",
      required: true,
      choices: ["Amount too small", "Relationship reasons", "Goodwill"],
      allowOther: true,
      placeholder: "Describe the reason",
    },
    availableFor: (ctx) => ACTIVE.includes(ctx.status),
  },
  opt_out: {
    id: "opt_out",
    label: "Opt out (do not contact)",
    description: "Permanently blocks all future contact across every channel for this customer.",
    destructive: true,
    confirm: true,
    input: { kind: "note", required: false, placeholder: "Note (optional)" },
    availableFor: (ctx) => ACTIVE.includes(ctx.status),
  },
  reopen_case: {
    id: "reopen_case",
    label: "Reopen case",
    description: "Resumes the case in the normal automated flow from its current step.",
    input: { kind: "note", required: true, placeholder: "e.g. dispute resolved in merchant's favour" },
    availableFor: (ctx) => REOPENABLE.includes(ctx.status),
  },
};

export function availableAdminActions(ctx: AdminActionContext): AdminActionDef[] {
  return ADMIN_ACTION_ORDER.map((id) => ADMIN_ACTIONS[id]).filter((a) => a.availableFor(ctx));
}

export function hasPendingStep(row: { next_attempt_at: string | null }, now = Date.now()): boolean {
  return row.next_attempt_at !== null && Date.parse(row.next_attempt_at) > now;
}
