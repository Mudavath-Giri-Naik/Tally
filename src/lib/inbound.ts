/**
 * Understanding what a customer said back.
 *
 * Deliberately deterministic rather than a model call. This runs inside a
 * webhook that Twilio expects to answer in milliseconds, and the two things it
 * decides - "stop contacting me" and "I will pay on <date>" - are exactly the
 * two where a confident wrong answer is most costly. A regex that fails to
 * match falls through to `other` and a human reads it; a model that
 * hallucinates a date silently schedules a chase for the wrong day.
 *
 * Handles English and the Hinglish people actually type.
 */

export type InboundIntent =
  | { kind: "opt_out"; matched: string }
  | { kind: "promise_to_pay"; dueDate: string; matched: string }
  /**
   * They intend to pay but named no day. Still not a trackable promise - but
   * it is not nothing either, and the right response is to ask which day
   * rather than to guess one or to hand the whole thing to a human.
   */
  | { kind: "promise_no_date"; matched: string }
  | { kind: "already_paid"; matched: string }
  | { kind: "other" };

/**
 * Twilio's standard opt-out keywords. When the whole message is one of these,
 * it is unambiguous - Twilio itself treats them this way.
 */
const STANDARD_STOP_WORDS = new Set([
  "stop",
  "stopall",
  "unsubscribe",
  "cancel",
  "end",
  "quit",
  "optout",
  "opt-out",
  "revoke",
]);

/**
 * Longer phrases that unambiguously mean stop. Matched anywhere in the
 * message, because these are not things people write by accident.
 */
const STOP_PHRASES: RegExp[] = [
  /\bopt(?:ing)?[\s-]?out\b/,
  // "messaging" is not "message" + "ing", so the stem has to be spelled out -
  // missing it means ignoring one of the most common ways people say stop.
  /\b(?:do\s*n[o']?t|dont|don't|stop|quit)\s+(?:messag(?:e|es|ing)|msg(?:ing)?|text(?:ing)?|contact(?:ing)?|call(?:ing)?|sms|whatsapp(?:ing)?|bother(?:ing)?|disturb(?:ing)?|sending)\s*(?:me)?\b/,
  /\bno\s+more\s+(?:messages?|texts?|msgs?|calls?|reminders?)\b/,
  /\bremove\s+(?:me|my\s+number)\b/,
  /\bunsubscribe\b/,
  /\bleave\s+me\s+alone\b/,
  // Hinglish / Hindi
  /\b(?:message|msg|call)\s*(?:mat|na)\s*(?:bhejo|karo|kro)\b/,
  /\bband\s*(?:karo|kro|kar\s*do)\b/,
  /\bnahi\s*chahiye\b/,
  /\bpareshan\s*mat\s*karo\b/,
];

/** "I already paid" - not a promise, and worth a human looking at it. */
const ALREADY_PAID_PHRASES: RegExp[] = [
  /\b(?:already|alredy)\s+(?:paid|payed|done|made)\b/,
  /\b(?:i|we)\s+(?:have\s+)?(?:paid|payed)\b/,
  /\bpayment\s+(?:is\s+)?(?:done|completed|successful)\b/,
  /\bpaid\s+(?:it\s+)?(?:already|yesterday|today)\b/,
  /\b(?:kar|ho)\s*(?:diya|gaya)\s*(?:hai)?\b.*\bpayment\b/,
  /\bpayment\b.*\b(?:kar|ho)\s*(?:diya|gaya)\b/,
];

/** An intent to pay, in the future. */
const PAY_INTENT: RegExp[] = [
  /\b(?:i|we)?\s*(?:will|'ll|ll|shall|can|would|gonna|going\s+to)\s+(?:try\s+to\s+)?(?:pay|make\s+the\s+payment|clear|settle|transfer)\b/,
  /\b(?:pay|paying|payment)\b.*\b(?:on|by|after|tomorrow|today|tonight|next|this)\b/,
  /\b(?:on|by)\b.*\b(?:i|we)\s+(?:will\s+)?pay\b/,
  /\bwill\s+(?:be\s+)?(?:paying|transferring|sending)\b/,
  // "I want to pay later", "I need to clear this" - an intention stated
  // without a modal verb, which every pattern above requires.
  /\b(?:i|we)?\s*(?:want|wanna|need)\s+to\s+(?:pay|clear|settle|make\s+the\s+payment)\b/,
  /\bpay(?:ing|ment)?\b[^.]{0,20}\blater\b/,
  /\blater\b[^.]{0,20}\bpay\b/,
  /\bpay\s+(?:it|you|this)?\s*(?:back)?\s*(?:on|by|tomorrow|today|tonight|next)\b/,
  // Hinglish
  /\b(?:pay|payment|paisa|paise)\b.*\b(?:kar|kr)\s*(?:dunga|dungi|denge|doonga|dena|dunga)\b/,
  /\b(?:kar|kr)\s*(?:dunga|dungi|denge|doonga)\b/,
  /\b(?:bhej|bhejta|bhejti)\s*(?:dunga|dungi|hoon|hu)\b/,
  /\bpayment\s+ho\s+jayega\b/,
];

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const MONTHS: Record<string, number> = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2,
  april: 3, apr: 3, may: 4, june: 5, jun: 5, july: 6, jul: 6,
  august: 7, aug: 7, september: 8, sep: 8, sept: 8,
  october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
};

/** Local calendar parts of an instant, in a given timezone. */
function localParts(at: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(at)) {
    if (part.type !== "literal") p[part.type] = part.value;
  }
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    weekday: WEEKDAYS[p.weekday.toLowerCase()] ?? 0,
  };
}

function toISODate(year: number, month1: number, day: number): string {
  // Normalises overflow (e.g. month 13 -> next January) via UTC arithmetic.
  const d = new Date(Date.UTC(year, month1 - 1, day));
  return d.toISOString().slice(0, 10);
}

/**
 * Pull a due date out of the reply, resolved against the merchant's local
 * "today". Returns null when the message names no time at all - a promise with
 * no date is not a promise we can track.
 */
export function extractDueDate(
  text: string,
  now: Date,
  timeZone: string,
): string | null {
  const t = text.toLowerCase();
  const today = localParts(now, timeZone);

  const plusDays = (n: number) => toISODate(today.year, today.month, today.day + n);

  // "day after tomorrow" before "tomorrow", or the shorter one wins.
  if (/\bday\s+after\s+tomorrow\b/.test(t) || /\bparso\b/.test(t)) return plusDays(2);
  if (/\btomorrow\b/.test(t) || /\btmrw\b/.test(t) || /\btmr\b/.test(t)) return plusDays(1);
  // In a payment promise, Hindi "kal" means tomorrow, not yesterday.
  if (/\bkal\b/.test(t)) return plusDays(1);
  // "now" is a date: it means today. Treating it as no-date-given would
  // make the agent ask "which day?" of someone who just said they are
  // paying right now.
  if (/\b(?:today|tonight|abhi|aaj|now)\b/.test(t)) return plusDays(0);

  // "in 3 days", "within 2 days", "3 din me"
  const inDays = t.match(/\b(?:in|within|after)\s+(\d{1,2})\s*(?:days?|din)\b/) ??
    t.match(/\b(\d{1,2})\s*(?:days?|din)\s*(?:me|mein|in)?\b/);
  if (inDays) {
    const n = Number(inDays[1]);
    if (n >= 0 && n <= 60) return plusDays(n);
  }

  // "in a week", "next week"
  if (/\bnext\s+week\b/.test(t) || /\bin\s+a\s+week\b/.test(t) || /\bek\s+hafte\b/.test(t)) {
    return plusDays(7);
  }
  if (/\bnext\s+month\b/.test(t)) return toISODate(today.year, today.month + 1, today.day);

  // "on the 15th", "by 15th", "15/03", "15 March"
  const dmy = t.match(/\b(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?\b/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      let year = dmy[3] ? Number(dmy[3]) : today.year;
      if (year < 100) year += 2000;
      // A date already past this year means they mean next year.
      const iso = toISODate(year, month, day);
      if (!dmy[3] && iso < toISODate(today.year, today.month, today.day)) {
        return toISODate(year + 1, month, day);
      }
      return iso;
    }
  }

  const namedMonth = t.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+)\b|\b([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\b/,
  );
  if (namedMonth) {
    const day = Number(namedMonth[1] ?? namedMonth[4]);
    const monthName = (namedMonth[2] ?? namedMonth[3] ?? "").toLowerCase();
    const month = MONTHS[monthName];
    if (month !== undefined && day >= 1 && day <= 31) {
      const iso = toISODate(today.year, month + 1, day);
      if (iso < toISODate(today.year, today.month, today.day)) {
        return toISODate(today.year + 1, month + 1, day);
      }
      return iso;
    }
  }

  // "on the 15th" with no month named - this month, or next if already past.
  const ordinal = t.match(/\b(?:on|by|before)\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/);
  if (ordinal) {
    const day = Number(ordinal[1]);
    if (day >= 1 && day <= 31) {
      if (day >= today.day) return toISODate(today.year, today.month, day);
      return toISODate(today.year, today.month + 1, day);
    }
  }

  // Weekday names: the next occurrence, never today.
  for (const [name, target] of Object.entries(WEEKDAYS)) {
    if (!new RegExp(`\\b${name}\\b`).test(t)) continue;
    let delta = (target - today.weekday + 7) % 7;
    if (delta === 0) delta = 7;
    if (/\bnext\s+\w*\b/.test(t) && delta < 7) delta += 0; // "next friday" ~ the coming friday
    return plusDays(delta);
  }

  // Payday language, matching the salary-window heuristic used elsewhere.
  if (/\b(?:salary|payday|pay\s*day|sailry|tankhwa|tankhwah)\b/.test(t)) {
    return toISODate(today.year, today.month + 1, 1);
  }
  if (/\b(?:month\s*end|end\s+of\s+(?:the\s+)?month|mahine\s+ke\s+end)\b/.test(t)) {
    return toISODate(today.year, today.month + 1, 0); // day 0 = last day of this month
  }

  return null;
}

/** Normalise for matching: lowercase, collapse whitespace, strip punctuation. */
function normalise(body: string): string {
  return body
    .toLowerCase()
    .replace(/[.,!?;:"'()\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Work out what an inbound reply means.
 *
 * Order matters: opt-out is checked first and wins outright. Someone who
 * writes "stop messaging me, I'll pay Friday" is telling us to stop, and
 * honouring that beats booking the follow-up.
 */
export function classifyReply(
  body: string,
  now: Date = new Date(),
  timeZone = "Asia/Kolkata",
): InboundIntent {
  const text = normalise(body ?? "");
  if (text === "") return { kind: "other" };

  // Whole message is a standard keyword.
  if (STANDARD_STOP_WORDS.has(text.replace(/\s+/g, ""))) {
    return { kind: "opt_out", matched: text };
  }
  for (const re of STOP_PHRASES) {
    const m = text.match(re);
    if (m) return { kind: "opt_out", matched: m[0] };
  }

  for (const re of ALREADY_PAID_PHRASES) {
    const m = text.match(re);
    if (m) return { kind: "already_paid", matched: m[0] };
  }

  const intent = PAY_INTENT.find((re) => re.test(text));
  if (intent) {
    const dueDate = extractDueDate(text, now, timeZone);
    if (dueDate) {
      return {
        kind: "promise_to_pay",
        dueDate,
        matched: text.match(intent)?.[0] ?? text,
      };
    }
    // Intent to pay but no date named. Never invent the deadline: say so, and
    // let the caller ask for one.
    return { kind: "promise_no_date", matched: text.match(intent)?.[0] ?? text };
  }

  return { kind: "other" };
}

/** Strip Twilio's channel prefix: "whatsapp:+919876543210" -> "+919876543210". */
export function stripChannelPrefix(address: string): string {
  return address.replace(/^(whatsapp|sms):/i, "").trim();
}
