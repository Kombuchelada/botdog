import {
  getLeaderboardStmt,
  getTotalHotdogsStmt,
  getAllEventsStmt,
  getLargestSingleSubmissionStmt,
  getAverageAmountPerEventStmt,
} from "./database.js";

export function getLeaderboard() {
  const rows = getLeaderboardStmt.all();
  let leaderboardText = "";
  if (rows.length === 0) {
    leaderboardText = "No hot dog counts yet!";
  } else {
    const allEvents = getAllEventsStmt.all();
    const userDates = buildUserDatesMap(allEvents);
    const userMaxDaily = buildUserMaxDailyMap(allEvents);
    let currentRank = 1;
    leaderboardText = rows
      .map((row, index) => {
        if (index > 0 && rows[index - 1].total_count !== row.total_count) {
          currentRank = index + 1;
        }
        const dates = userDates.get(row.user_id) ?? new Set();
        const numDaysInStreak = getCurrentStreak(dates);
        const longestStreak = getLongestStreakEver(dates);
        const maxInADay = userMaxDaily.get(row.user_id) ?? 0;
        return `${currentRank}. <@${row.user_id}> - ${row.total_count} hot dogs, Current streak: ${numDaysInStreak} day(s), Longest streak: ${longestStreak} day(s), Most in a day: ${maxInADay} dog(s)`;
      })
      .join("\n");
  }
  return leaderboardText;
}

export function getStats() {
  return {
    totalDogsConsumed: getTotalHotdogsStmt.get().total_hotdogs || 0,
    dogsPerDay: getDogsPerDay(),
    dogsPerMonth: getDogsPerMonth(),
    longestDailyStreak: getLongestDailyStreak(),
    largestSingleSessionSubmission: getLargestSingleSessionSubmission(),
    averageAmountPerDbRow: getAverageAmountPerDbRow(),
  };
}

function getDogsPerDay() {
  const allEvents = getAllEventsStmt.all();
  const totalDogsConsumed = getTotalHotdogsStmt.get().total_hotdogs || 0;
  let dogsPerDay = 0;
  if (allEvents.length > 0) {
    const firstEventTime = new Date(allEvents[allEvents.length - 1].timestamp);
    const now = new Date();
    const daysElapsed =
      (now.getTime() - firstEventTime.getTime()) / (1000 * 60 * 60 * 24);
    dogsPerDay = (totalDogsConsumed / daysElapsed).toFixed(2);
  }
  return dogsPerDay;
}

function getDogsPerMonth() {
  const totalDogsConsumed = getTotalHotdogsStmt.get().total_hotdogs || 0;
  const daysInAMonth = 30.4;
  const startDate = new Date(1767254400000); // 1/1/2026 at midnight
  const today = new Date();
  const millisecondsDifference = today - startDate;
  const dayDifference = millisecondsDifference / (1000 * 3600 * 24);
  const monthsElapsed = dayDifference / daysInAMonth;
  return (totalDogsConsumed / monthsElapsed).toFixed();
}

function buildUserMaxDailyMap(allEvents) {
  const userDailyTotals = new Map();
  for (const event of allEvents) {
    const dateKey = toPacificDateKey(parseUtcTimestamp(event.timestamp));
    if (!userDailyTotals.has(event.user_id)) {
      userDailyTotals.set(event.user_id, new Map());
    }
    const dailyMap = userDailyTotals.get(event.user_id);
    dailyMap.set(dateKey, (dailyMap.get(dateKey) ?? 0) + event.amount);
  }
  const userMaxDaily = new Map();
  for (const [userId, dailyMap] of userDailyTotals.entries()) {
    userMaxDaily.set(userId, Math.max(...dailyMap.values()));
  }
  return userMaxDaily;
}

function buildUserDatesMap(allEvents) {
  const userDates = new Map();
  for (const event of allEvents) {
    const dateKey = toPacificDateKey(parseUtcTimestamp(event.timestamp));
    if (!userDates.has(event.user_id)) {
      userDates.set(event.user_id, new Set());
    }
    userDates.get(event.user_id).add(dateKey);
  }
  return userDates;
}

function getLongestStreakEver(dates) {
  if (dates.size === 0) return 0;
  const sorted = Array.from(dates).sort();
  let maxStreak = 1;
  let streak = 1;
  for (let i = 1; i < sorted.length; i++) {
    const diffMs = new Date(sorted[i]) - new Date(sorted[i - 1]);
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays === 1) {
      maxStreak = Math.max(maxStreak, ++streak);
    } else {
      streak = 1;
    }
  }
  return maxStreak;
}

function getCurrentStreak(dates) {
  const now = new Date();
  const todayKey = toPacificDateKey(now);
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const yesterdayKey = toPacificDateKey(yesterday);

  if (!dates.has(todayKey) && !dates.has(yesterdayKey)) {
    return 0;
  }

  let streak = 0;
  let cursorTime = dates.has(todayKey) ? now.getTime() : yesterday.getTime();

  while (dates.has(toPacificDateKey(new Date(cursorTime)))) {
    streak += 1;
    cursorTime -= 24 * 60 * 60 * 1000;
  }

  return streak;
}

function getLongestDailyStreak() {
  const allEvents = getAllEventsStmt.all();
  if (allEvents.length === 0) {
    return { userIds: [], days: 0 };
  }

  const userDates = buildUserDatesMap(allEvents);

  let maxDays = 0;
  const streaksByUser = new Map();

  for (const [userId, dates] of userDates.entries()) {
    const streak = getCurrentStreak(dates);
    streaksByUser.set(userId, streak);
    if (streak > maxDays) {
      maxDays = streak;
    }
  }

  if (maxDays === 0) {
    return { userIds: [], days: 0 };
  }

  const userIds = [];
  for (const [userId, streak] of streaksByUser.entries()) {
    if (streak === maxDays) {
      userIds.push(userId);
    }
  }

  return { userIds, days: maxDays };
}

function toPacificDateKey(date) {
  // Convert UTC date to Pacific Time
  const pacificDateString = date.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // Format is MM/DD/YYYY, convert to YYYY-MM-DD
  const [month, day, year] = pacificDateString.split("/");
  return `${year}-${month}-${day}`;
}

function parseUtcTimestamp(timestamp) {
  if (!timestamp) {
    return new Date(NaN);
  }
  if (timestamp instanceof Date) {
    return timestamp;
  }
  const normalized = String(timestamp).includes("T")
    ? String(timestamp)
    : String(timestamp).replace(" ", "T");
  return new Date(`${normalized}Z`);
}

function getLargestSingleSessionSubmission() {
  const largest = getLargestSingleSubmissionStmt.get();
  if (!largest) {
    return { userId: null, username: null, amount: 0, timestamp: null };
  }

  return {
    userId: largest.user_id,
    username: largest.username,
    amount: largest.amount,
    timestamp: largest.timestamp,
  };
}

function getAverageAmountPerDbRow() {
  const row = getAverageAmountPerEventStmt.get();
  if (!row || row.average_amount === null || row.average_amount === undefined) {
    return 0;
  }
  return Number.parseFloat(Number(row.average_amount).toFixed(2));
}
