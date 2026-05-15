import {
  db,
  getTotalHotdogsStmt,
} from "./database.js";
import {
  buildUserDatesMap,
  getCurrentStreak,
  toPacificDateKey,
  parseUtcTimestamp,
} from "./stats.js";

const USER_TOTAL_MILESTONES = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
const SERVER_TOTAL_MILESTONES = [1000, 2500, 5000, 10000, 25000, 50000, 100000];
const SINGLE_SITTING_TIERS = [
  { threshold: 20, label: "Maximum Glizzy" },
  { threshold: 15, label: "Glizzy Champion" },
  { threshold: 10, label: "Heroic Sitting" },
  { threshold: 5, label: "Big Plate" },
];
const STREAK_MILESTONES = [3, 7, 14, 30, 60, 100, 365];

const getAllPositiveEventsStmt = db.prepare(
  "SELECT user_id, timestamp FROM hotdog_events WHERE amount > 0",
);

/**
 * Detect achievement triggers for a fresh /hotdog submission.
 *
 * Pure read-only: doesn't mutate anything. Returns an array of {emoji, line}
 * objects in order of significance (highest first).
 *
 * @param {object} params
 * @param {string} params.userId        - the submitting user
 * @param {string} params.username      - their display name
 * @param {number} params.amount        - amount in this submission (must be > 0)
 * @param {number} params.userTotalAfter   - their total AFTER this submission
 * @param {number} params.serverTotalAfter - server total AFTER this submission
 */
export function detectAchievements({ userId, username, amount, userTotalAfter, serverTotalAfter }) {
  const triggers = [];
  if (!Number.isInteger(amount) || amount <= 0) return triggers;

  // 1. Single-sitting tier (highest threshold met wins)
  for (const tier of SINGLE_SITTING_TIERS) {
    if (amount >= tier.threshold) {
      triggers.push({
        emoji: "🌭🌭🌭",
        line: `**${tier.label}** — ${amount} in one sitting!`,
      });
      break;
    }
  }

  // 2. User total crossings
  const userBefore = userTotalAfter - amount;
  for (const m of USER_TOTAL_MILESTONES) {
    if (userBefore < m && userTotalAfter >= m) {
      triggers.push({
        emoji: "🏅",
        line: `**${m} hot dogs!** ${username} has officially hit ${m}.`,
      });
    }
  }

  // 3. Server total crossings
  const serverBefore = serverTotalAfter - amount;
  for (const m of SERVER_TOTAL_MILESTONES) {
    if (serverBefore < m && serverTotalAfter >= m) {
      triggers.push({
        emoji: "🎉",
        line: `**Server hits ${m} hot dogs!** Pushed over by ${username}.`,
      });
    }
  }

  // 4. Streak milestone — only fires when this is the FIRST submission of today
  //    (otherwise the streak counter didn't tick today; it ticked on an earlier message).
  const todayKey = toPacificDateKey(new Date());
  const allEvents = getAllPositiveEventsStmt.all();
  const userTodayCount = allEvents.filter(
    (e) => e.user_id === userId && toPacificDateKey(parseUtcTimestamp(e.timestamp)) === todayKey,
  ).length;
  if (userTodayCount === 1) {
    const datesMap = buildUserDatesMap(allEvents);
    const streak = getCurrentStreak(datesMap.get(userId) || new Set());
    if (STREAK_MILESTONES.includes(streak)) {
      triggers.push({
        emoji: "🔥",
        line: `**${streak}-day streak!** ${username} has eaten hot dogs ${streak} days running.`,
      });
    }
  }

  return triggers;
}

/**
 * Format triggers for inclusion in the /hotdog response message.
 * Returns "" when nothing fired.
 */
export function formatAchievementsForResponse(triggers) {
  if (!triggers || triggers.length === 0) return "";
  return "\n\n" + triggers.map((t) => `${t.emoji} ${t.line}`).join("\n");
}
