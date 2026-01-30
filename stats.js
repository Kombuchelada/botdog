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
    let currentRank = 1;
    leaderboardText = rows
      .map((row, index) => {
        // If this isn't the first row and the count is different from previous, update rank
        if (index > 0 && rows[index - 1].total_count !== row.total_count) {
          currentRank = index + 1;
        }
        return `${currentRank}. <@${row.user_id}> - ${row.total_count} hot dogs`;
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
  const allEvents = getAllEventsStmt.all();
  let dogsPerMonth = 0;
  if (allEvents.length > 0) {
    const firstEventTime = new Date(allEvents[allEvents.length - 1].timestamp);
    const now = new Date();
    const monthsElapsed =
      (now.getFullYear() - firstEventTime.getFullYear()) * 12 +
      (now.getMonth() - firstEventTime.getMonth());
    if (monthsElapsed > 0) {
      dogsPerMonth = (totalDogsConsumed / monthsElapsed).toFixed(2);
    } else {
      dogsPerMonth = totalDogsConsumed;
    }
  }
  return dogsPerMonth;
}

function getLongestDailyStreak() {
  const allEvents = getAllEventsStmt.all();
  if (allEvents.length === 0) {
    return { userId: null, username: null, days: 0 };
  }

  const userDates = new Map();

  for (const event of allEvents) {
    const dateKey = toLocalDateKey(new Date(event.timestamp));
    if (!userDates.has(event.user_id)) {
      userDates.set(event.user_id, {
        username: event.username,
        dates: new Set(),
      });
    }
    userDates.get(event.user_id).dates.add(dateKey);
  }

  const today = new Date();
  const todayKey = toLocalDateKey(today);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = toLocalDateKey(yesterday);

  let best = { userId: null, username: null, days: 0 };

  for (const [userId, { username, dates }] of userDates.entries()) {
    if (!dates.has(todayKey) && !dates.has(yesterdayKey)) {
      continue;
    }

    let streak = 0;
    const cursor = dates.has(todayKey) ? new Date(today) : new Date(yesterday);

    while (dates.has(toLocalDateKey(cursor))) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    }

    if (streak > best.days) {
      best = { userId, username, days: streak };
    }
  }

  return best;
}

function toLocalDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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
