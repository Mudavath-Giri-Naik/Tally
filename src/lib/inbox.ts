/**
 * The queue: every case actually waiting on a person, ranked by what's at
 * stake.
 *
 * Everything else on the dashboard describes what happened. This answers the
 * one question a merchant opens the app to ask on an ordinary Tuesday -
 * "what needs me right now" - which today means digging through the
 * Customers table's status filter to find out. Deliberately narrow: only the
 * two statuses where the agent has genuinely stopped and handed off, not
 * every case that merely looks unfinished.
 */
import type { BoardRow } from "./board";

/**
 * "Needs human" and "Disputed" are the only two states where a person is
 * the next thing that has to happen. Escalated-to-voice is left out on
 * purpose: a call is still the agent acting on its own, not a handoff - it
 * belongs on the Customers table, not in a queue promising "this one needs
 * you specifically."
 */
const WAITING_ON_A_PERSON: ReadonlySet<BoardRow["status"]> = new Set([
  "needs_human",
  "disputed",
]);

export function needsAttention(row: BoardRow): boolean {
  return WAITING_ON_A_PERSON.has(row.status);
}

/**
 * The queue itself: filtered, then ranked by money at risk - the amount a
 * merchant would want to triage first, not the order cases happened to load
 * in. A tie keeps the older case first, since two identical amounts should
 * not visibly reorder themselves as the page polls.
 */
export function buildInbox(rows: BoardRow[]): BoardRow[] {
  return rows
    .filter(needsAttention)
    .sort((a, b) => {
      const byAmount = (b.amount ?? 0) - (a.amount ?? 0);
      if (byAmount !== 0) return byAmount;
      return Date.parse(a.failed_on) - Date.parse(b.failed_on);
    });
}
