/**
 * The numbered menu a customer can drive the conversation with.
 *
 * Why numbers and not buttons: WhatsApp's tappable quick replies need a
 * registered WhatsApp sender and approved Content Templates. The Twilio
 * Sandbox this runs on cannot send them - "You can't use custom message
 * templates with the Sandbox" - so a numbered list is the only interactive
 * shape that works today.
 *
 * It is kept behind `renderMenu` for exactly that reason. When the merchant
 * registers a real sender, the same MenuOption[] becomes the quick-reply
 * buttons of a Content Template, and nothing else in this file changes.
 *
 * Menus are deterministic on purpose. "2 = stop" must mean stop every single
 * time, not usually - so no model sits between the customer's keypress and
 * the effect.
 */

/** Which menu was last shown. Recorded on the action, read on the next reply. */
export type MenuId = "root" | "options";

/** What a chosen option asks the system to do. */
export type MenuAction =
  | "show_options"
  | "opt_out"
  | "pay_now"
  | "pay_later"
  | "already_paid"
  | "talk_to_human";

export interface MenuOption {
  /** What the customer types. Also the button order once buttons exist. */
  key: string;
  label: string;
  action: MenuAction;
  /** Words that select this option without the number. */
  aliases?: string[];
}

export const MENUS: Record<MenuId, MenuOption[]> = {
  root: [
    {
      key: "1",
      label: "See my options",
      action: "show_options",
      aliases: ["options", "option", "menu", "help", "choices"],
    },
    {
      key: "2",
      label: "Stop these messages",
      action: "opt_out",
      // "stop" is handled earlier by the opt-out classifier regardless; this
      // is here so the menu is self-consistent if that ever changes.
      aliases: ["stop", "unsubscribe"],
    },
  ],
  options: [
    {
      key: "1",
      label: "Pay now - send me the link",
      action: "pay_now",
      aliases: ["pay now", "link", "pay"],
    },
    {
      key: "2",
      label: "I'll pay later - I'll give a date",
      action: "pay_later",
      aliases: ["later", "pay later"],
    },
    {
      key: "3",
      label: "I've already paid",
      action: "already_paid",
      aliases: ["already paid", "paid"],
    },
    {
      key: "4",
      label: "Talk to a person",
      action: "talk_to_human",
      aliases: ["human", "person", "agent", "support"],
    },
    {
      key: "5",
      label: "Stop these messages",
      action: "opt_out",
      aliases: ["stop", "unsubscribe"],
    },
  ],
};

/**
 * Render a menu as WhatsApp text.
 *
 * The lead line carries the actual situation, because a menu with no context
 * is a phone tree - the customer should not have to remember which payment
 * this is about.
 */
export function renderMenu(id: MenuId, lead: string): string {
  return `${lead}\n\n${menuBlock(id)}`;
}

/**
 * Just the numbered options, with no lead line.
 *
 * For appending to a message that has already explained itself in its own
 * words - the worker's first dunning message, which does not need a second
 * sentence telling the customer what the payment was.
 */
export function menuBlock(id: MenuId): string {
  const rows = MENUS[id].map((o) => `${o.key}. ${o.label}`).join("\n");
  return `Reply with a number:\n${rows}`;
}

/**
 * Which option did they pick?
 *
 * Accepts the number, the number with punctuation a keyboard adds ("1." or
 * "1)"), or the option's own words - people answer a numbered list in prose
 * about as often as they answer it with a digit.
 */
export function resolveChoice(id: MenuId, body: string): MenuOption | null {
  const text = body
    .toLowerCase()
    .replace(/[.,!?;:"'()\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;

  for (const option of MENUS[id]) {
    if (text === option.key) return option;
    if (option.aliases?.some((a) => text === a)) return option;
  }

  // A longer sentence that happens to contain an alias ("ok send me the
  // link please"). Checked second so an exact match always wins.
  for (const option of MENUS[id]) {
    if (option.aliases?.some((a) => text.includes(a))) return option;
  }
  return null;
}

/**
 * Which menu, if any, does this outbound message end with?
 *
 * The guardrail on the action row is the primary record of what was asked.
 * This is the fallback for messages that carry a menu without being *about*
 * the menu - the worker's first dunning message appends one, and its action
 * row is already using its guardrail to explain the recovery decision.
 *
 * Matching on the rendered first option rather than the whole block, so the
 * lead line (which differs per customer) does not affect it.
 */
export function detectMenu(text: string | null): MenuId | null {
  if (!text) return null;
  for (const id of Object.keys(MENUS) as MenuId[]) {
    const first = MENUS[id][0];
    if (text.includes(`${first.key}. ${first.label}`)) return id;
  }
  return null;
}

/**
 * Is this just a greeting?
 *
 * The trigger for showing the menu at all. Kept tight: a greeting with a real
 * question attached ("hi why did my card fail") is a question, and answering
 * it with a menu would be worse than useless.
 */
const GREETINGS = new Set([
  "hi",
  "hii",
  "hiii",
  "hello",
  "helo",
  "hey",
  "heyy",
  "yo",
  "hola",
  "namaste",
  "namaskar",
  "salaam",
  "hi there",
  "hello there",
  "good morning",
  "good afternoon",
  "good evening",
  "start",
  "menu",
  "options",
  "help",
]);

/** Filler that carries no meaning of its own and should not block a match. */
const FILLER = new Set(["bro", "sir", "madam", "ma'am", "boss", "bhai", "ji", "dear", "team"]);

export function isGreeting(body: string): boolean {
  const text = body
    .toLowerCase()
    .replace(/[.,!?;:"'()\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return false;
  if (GREETINGS.has(text)) return true;

  // "hi bro", "hello sir" - a greeting plus filler is still just a greeting.
  const words = text.split(" ").filter((w) => !FILLER.has(w));
  if (words.length === 0) return false;
  return words.length <= 2 && GREETINGS.has(words.join(" "));
}
