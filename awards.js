// The Year of the Glizzy's final awards, computed from the season's events.
//
// Pure: takes the rows, returns the results. The finale (Discord embed, the
// memorial front page, the Year in Review story) all read this one function,
// so they can never disagree about who won what.
//
// Every award obeys the rule the rest of the site learned the hard way: a day
// is worth what it nets. Protests are free-floating negative rows, so anything
// that read raw positive rows would hand out trophies for meals argued away.
// Counts go through cappedSittings (each sitting capped by its day's net);
// days go through buildUserDatesMap (a day counts only if it nets positive).
//
// Ties share an award. Nobody wins with a zero.

import {
  buildUserDatesMap,
  buildUserMaxDailyMap,
  buildUserMaxSittingMap,
  cappedSittings,
  getLongestStreakEver,
  pacificHour,
  parseUtcTimestamp,
  toPacificDateKey,
} from "./stats.js";

// Best Late Entry: people whose first dog came on or after this Pacific day.
export const LATE_ENTRY_KEY = "2026-03-01";

// Leaders of a Map<userId, number>: everyone tied at the top, if the top is > 0.
function leaders(map) {
  let best = 0;
  for (const v of map.values()) if (v > best) best = v;
  if (best <= 0) return null;
  const userIds = [...map.entries()].filter(([, v]) => v === best).map(([id]) => id).sort();
  return { userIds, value: best };
}

function sumBy(entries) {
  const map = new Map();
  for (const [id, v] of entries) map.set(id, (map.get(id) || 0) + v);
  return map;
}

/**
 * @param {Array<{user_id: string, amount: number, timestamp: string}>} events
 *   The season's rows (getAllEventsStmt), protests included.
 */
export function computeAwards(events) {
  const net = sumBy(events.map((e) => [e.user_id, e.amount]));
  const sittings = cappedSittings(events);
  const datesMap = buildUserDatesMap(events);

  // Standings with competition ranking (1, 1, 3): ties share a place.
  const standings = [...net.entries()]
    .filter(([, total]) => total > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([userId, total]) => ({ userId, total }));
  standings.forEach((row, i) => {
    row.rank = i > 0 && standings[i - 1].total === row.total ? standings[i - 1].rank : i + 1;
  });
  const atRank = (rank) => {
    const rows = standings.filter((r) => r.rank === rank);
    return rows.length ? { userIds: rows.map((r) => r.userId), value: rows[0].total } : null;
  };

  const atHour = (pred) =>
    sumBy(
      sittings
        .filter(({ event }) => pred(pacificHour(parseUtcTimestamp(event.timestamp))))
        .map(({ event, amount }) => [event.user_id, amount]),
    );

  const firstDay = new Map();
  for (const [userId, dates] of datesMap) {
    if (dates.size) firstDay.set(userId, [...dates].sort()[0]);
  }
  const lateNet = new Map(
    [...net].filter(([id, total]) => total > 0 && firstDay.get(id) >= LATE_ENTRY_KEY),
  );

  const protestedAgainst = sumBy(
    events.filter((e) => e.amount < 0).map((e) => [e.user_id, -e.amount]),
  );

  // The whole group, one day at a time.
  const groupDaily = sumBy(
    events.map((e) => [toPacificDateKey(parseUtcTimestamp(e.timestamp)), e.amount]),
  );
  const bestGroupDay = leaders(groupDaily);

  const awards = [
    { id: "champion", emoji: "👑", name: "Glizzy Champion", blurb: "Most dogs in 2026", unit: "dogs", ...atRank(1) },
    { id: "second", emoji: "🥈", name: "Runner-Up", blurb: "Second place", unit: "dogs", ...atRank(2) },
    { id: "third", emoji: "🥉", name: "Third Place", blurb: "Third place", unit: "dogs", ...atRank(3) },
    {
      id: "iron_stomach", emoji: "🔥", name: "Iron Stomach", blurb: "Longest streak", unit: "days",
      ...leaders(new Map([...datesMap].map(([id, d]) => [id, getLongestStreakEver(d)]))),
    },
    {
      id: "big_sitting", emoji: "🍽️", name: "Big Sitting", blurb: "Most dogs in one sitting", unit: "dogs",
      ...leaders(buildUserMaxSittingMap(events)),
    },
    {
      id: "best_day", emoji: "📅", name: "Best Day", blurb: "Most dogs in one day", unit: "dogs",
      ...leaders(buildUserMaxDailyMap(events)),
    },
    { id: "early_bird", emoji: "🌅", name: "Early Bird", blurb: "Most dogs before 8 AM", unit: "dogs", ...leaders(atHour((h) => h < 8)) },
    { id: "night_owl", emoji: "🦉", name: "Night Owl", blurb: "Most dogs after 10 PM", unit: "dogs", ...leaders(atHour((h) => h >= 22)) },
    {
      id: "most_consistent", emoji: "🗓️", name: "Most Consistent", blurb: "Most days with a dog", unit: "days",
      ...leaders(new Map([...datesMap].map(([id, d]) => [id, d.size]))),
    },
    { id: "most_protested", emoji: "⚖️", name: "Most Protested", blurb: "Most dogs protested away", unit: "dogs", ...leaders(protestedAgainst) },
    { id: "late_entry", emoji: "🚪", name: "Best Late Entry", blurb: "Most dogs among those who started after March 1", unit: "dogs", ...leaders(lateNet) },
  ].filter((a) => a.userIds);

  let groupDays = 0;
  for (const v of groupDaily.values()) if (v > 0) groupDays++;

  return {
    standings,
    awards,
    group: {
      total: [...net.values()].reduce((s, v) => s + v, 0),
      participants: standings.length,
      activeDays: groupDays,
      bestDay: bestGroupDay ? { dateKeys: bestGroupDay.userIds, value: bestGroupDay.value } : null,
    },
  };
}
