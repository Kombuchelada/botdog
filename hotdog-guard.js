import { parseUtcTimestamp } from "./stats.js";

// Discord gives an interaction 3 seconds. When the server is slow the row is
// already inserted by the time Discord gives up, the user sees "The application
// did not respond" (visible only to them), and they run /hotdog again — so the
// same meal lands twice with only one public reply. That happened to a 4-dog
// log on 2026-10-03. A repeat of the same amount this soon asks first.
export const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;

/**
 * The user's latest event if `amount` looks like a re-submission of it, else
 * null. `latest` is the user's most recent hotdog_events row (or undefined).
 */
export function findRecentDuplicate(latest, amount, now = new Date()) {
  if (!latest || latest.amount !== amount) return null;
  const age = now.getTime() - parseUtcTimestamp(latest.timestamp).getTime();
  if (!(age >= 0 && age < DUPLICATE_WINDOW_MS)) return null;
  return latest;
}
