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
    return { userIds: [], days: 0 };
  }

  const userDates = new Map();

  for (const event of allEvents) {
    const dateKey = toPacificDateKey(parseUtcTimestamp(event.timestamp));
    if (!userDates.has(event.user_id)) {
      userDates.set(event.user_id, new Set());
    }
    userDates.get(event.user_id).add(dateKey);
  }

  const now = new Date();
  const todayKey = toPacificDateKey(now);
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const yesterdayKey = toPacificDateKey(yesterday);

  let maxDays = 0;
  const streaksByUser = new Map();

  for (const [userId, dates] of userDates.entries()) {
    if (!dates.has(todayKey) && !dates.has(yesterdayKey)) {
      streaksByUser.set(userId, 0);
      continue;
    }

    let streak = 0;
    let cursorTime = dates.has(todayKey) ? now.getTime() : yesterday.getTime();

    while (dates.has(toPacificDateKey(new Date(cursorTime)))) {
      streak += 1;
      cursorTime -= 24 * 60 * 60 * 1000;
    }

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
