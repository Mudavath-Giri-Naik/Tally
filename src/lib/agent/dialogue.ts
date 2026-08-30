/**
 * What to say back, and whether a model is needed to say it.
 *
 * Sits between the inbound webhook and the conversational agent. Most turns in
 * a dunning conversation are not open-ended: a greeting wants a menu, a menu
 * choice wants the thing it selected, and "I'll pay later" wants one question
 * back. Those are answered deterministically - same input, same output, no
 * tokens spent, no chance of a model deciding today is the day to improvise
 * about someone's debt.
 *
 * Everything else falls through to the conversational agent.
 *
 * Conversation state is not stored anywhere new. What the agent last asked is
 * recorded as the guardrail on its own action row, and read back here - the
 * audit trail already had to contain it.
 */
import { db } from "../supabase";
import { extractDueDate } from "../inbound";
import {
  renderMenu,
  resolveChoice,
  isGreeting,
  detectMenu,
  type MenuId,
  type MenuAction,
} from "../menu";
import { formatINR } from "../types";
import type { Customer, Merchant, RecoveryEvent } from "../types";
import type { InboundIntent } from "../inbound";

/** Guardrail values that mean "the agent is waiting for a specific answer". */
export const PROMPT_ROOT_MENU = "menu_root";
export const PROMPT_OPTIONS_MENU = "menu_options";
export const PROMPT_AWAITING_DATE = "awaiting_promise_date";

const MENU_PROMPTS: Record<string, MenuId> = {
  [PROMPT_ROOT_MENU]: "root",
  [PROMPT_OPTIONS_MENU]: "options",
};

/**
 * What the agent last asked this customer, if anything.
 *
 * Only the most recent outbound turn counts: a menu shown three messages ago
 * has been superseded by whatever was said since, and treating a stale "2" as
 * an opt-out would be a serious misread.
 */
export async function pendingPrompt(customerId: string): Promise<string | null> {
  const { data, error } = await db()
    .from("actions")
    .select("message, decision, events!inner(customer_id)")
    .eq("events.customer_id", customerId)
    .not("message", "is", null)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`Could not read the last prompt: ${error.message}`);

  const row = (data ?? [])[0] as Record<string, any> | undefined;
  if (!row) return null;

  const message = String(row.message ?? "");
  // An inbound row means the customer has spoken since; nothing is pending.
  if (message.startsWith("[inbound] ")) return null;

  const guardrail = (row.decision?.guardrail as string) ?? null;
  if (guardrail && (MENU_PROMPTS[guardrail] || guardrail === PROMPT_AWAITING_DATE)) {
    return guardrail;
  }

  // No guardrail naming a menu, but the message may still have ended with
  // one - the worker's first contact appends a menu to copy whose guardrail
  // is already explaining the recovery decision.
  const shown = detectMenu(message);
  if (shown) return shown === "root" ? PROMPT_ROOT_MENU : PROMPT_OPTIONS_MENU;

  return guardrail;
}

export type DialogueMove =
  /** Send this exact text. No model involved. */
  | { kind: "say"; text: string; prompt?: string; action?: MenuAction }
  /** Book a promise for this date, then confirm it. */
  | { kind: "promise"; dueDate: string; text: string }
  /** Opt them out. */
  | { kind: "opt_out" }
  /** Nothing scripted fits - let the conversational agent answer. */
  | { kind: "converse" };

/** The one-line summary of what is owed, used as a menu's lead line. */
export function situationLine(
  merchant: Merchant,
  events: RecoveryEvent[],
): string {
  const open = events.filter(
    (e) => e.status === "queued" || e.status === "processing",
  );
  if (open.length === 0) {
    return `Hi - this is ${merchant.business_name}. There is nothing outstanding on your account right now.`;
  }
  const total = open.reduce((sum, e) => sum + (e.amount ?? 0), 0);
  const what =
    open.length === 1
      ? `a pending payment of ${formatINR(total)}`
      : `${open.length} pending payments totalling ${formatINR(total)}`;
  return `Hi - this is ${merchant.business_name} about ${what}.`;
}

function friendlyDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

const ASK_FOR_DATE =
  "Which day works for you? Reply with a date - for example \"tomorrow\", \"5 Sep\", or \"next Friday\".";

/**
 * Decide the next move.
 *
 * Order matters. A pending question is checked before the classifier, because
 * "2" means nothing on its own and everything directly after a menu.
 */
export function decideMove(
  ctx: {
    merchant: Merchant;
    customer: Customer;
    events: RecoveryEvent[];
    body: string;
    intent: InboundIntent;
    pending: string | null;
    now?: Date;
  },
): DialogueMove {
  const { merchant, customer, events, body, intent, pending } = ctx;
  const now = ctx.now ?? new Date();

  // 1. An explicit stop always wins, wherever it arrives.
  if (intent.kind === "opt_out") return { kind: "opt_out" };

  // 2. Answering a menu that is actually on screen.
  const menuId = pending ? MENUS_FOR(pending) : null;
  if (menuId) {
    const choice = resolveChoice(menuId, body);
    if (choice) return moveForChoice(choice.action, merchant, customer, events);
    // No match: fall through and let the agent answer whatever they said
    // instead. Repeating "invalid option, please try again" is what makes an
    // automated line feel like a wall.
  }

  // 3. They were asked for a date and have answered with one.
  if (pending === PROMPT_AWAITING_DATE) {
    const dueDate = extractDueDate(body, now, merchant.timezone);
    if (dueDate) {
      return {
        kind: "promise",
        dueDate,
        text: `Noted - we will expect it by ${friendlyDate(dueDate)} and will not chase you before then.`,
      };
    }
    // Asked once, got no date. Asking a second time is a loop; hand it to the
    // agent, which can work out what they actually meant.
    return { kind: "converse" };
  }

  // 4. A promise with a real date, however it arrived.
  if (intent.kind === "promise_to_pay") {
    return {
      kind: "promise",
      dueDate: intent.dueDate,
      text: `Noted - we will expect it by ${friendlyDate(intent.dueDate)} and will not chase you before then.`,
    };
  }

  // 5. They intend to pay but named no day. This is the question worth asking.
  if (intent.kind === "promise_no_date") {
    return { kind: "say", text: ASK_FOR_DATE, prompt: PROMPT_AWAITING_DATE };
  }

  // 6. A bare greeting, or an explicit request for the menu.
  if (isGreeting(body)) {
    return {
      kind: "say",
      text: renderMenu("root", situationLine(merchant, events)),
      prompt: PROMPT_ROOT_MENU,
    };
  }

  return { kind: "converse" };
}

function MENUS_FOR(prompt: string): MenuId | null {
  return MENU_PROMPTS[prompt] ?? null;
}

function moveForChoice(
  action: MenuAction,
  merchant: Merchant,
  customer: Customer,
  events: RecoveryEvent[],
): DialogueMove {
  switch (action) {
    case "show_options":
      return {
        kind: "say",
        text: renderMenu("options", "What would you like to do?"),
        prompt: PROMPT_OPTIONS_MENU,
      };

    case "opt_out":
      return { kind: "opt_out" };

    case "pay_later":
      return { kind: "say", text: ASK_FOR_DATE, prompt: PROMPT_AWAITING_DATE };

    case "pay_now":
      // The link is created per attempt by the worker, so this does not mint
      // one here - it lets the agent answer with the current link in context.
      return { kind: "converse" };

    case "already_paid":
      return {
        kind: "say",
        text: `Thanks - we will check this against ${merchant.business_name}'s payment records and come back to you. You will not be chased in the meantime.`,
        prompt: "customer_claims_paid",
        action: "already_paid",
      };

    case "talk_to_human":
      return {
        kind: "say",
        text: `Of course - someone from ${merchant.business_name} will pick this up and reply here.`,
        prompt: "reply_needs_human",
        action: "talk_to_human",
      };
  }
}
