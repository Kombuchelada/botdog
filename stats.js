import {
  getLeaderboardStmt,
  getTotalHotdogsStmt,
  getAllEventsStmt,
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
  const totalDogsConsumed = getTotalHotdogsStmt.get().total_hotdogs || 0;
  const allEvents = getAllEventsStmt.all();
  // calculate dogs per day since first event
  let dogsPerDay = 0;
  if (allEvents.length > 0) {
    const firstEventTime = new Date(allEvents[allEvents.length - 1].timestamp);
    const now = new Date();
    const daysElapsed =
      (now.getTime() - firstEventTime.getTime()) / (1000 * 60 * 60 * 24);
    dogsPerDay = (totalDogsConsumed / daysElapsed).toFixed(2);
  }

  return {
    totalDogsConsumed,
    dogsPerDay,
    dogsPerMonth: getDogsPerMonth(),
  };
}

export function getDogsPerMonth() {
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
