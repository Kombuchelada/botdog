// The Year of the Glizzy is a season with an end: 2026, Pacific time. After
// midnight Pacific on New Year's Day the competition is over and every public
// number freezes on what stood at that moment.
//
// Only the *competition* is bounded. /hotdog keeps writing rows after the
// season, and GlizzyClicker keeps reading every row ever logged — its bonuses
// run in perpetuity. So a statement that feeds a leaderboard, the dashboard or a
// chart reads the season; anything the game reads is lifetime. database.js
// holds both kinds, named so the difference can't be missed.
//
// There is deliberately no season *start*. Dogs were being logged before
// 2026-01-01 (the heatmaps have always started on 2025-12-31), and they have
// always counted. Adding a start bound would quietly take them off the board.
//
// Imports nothing, so database.js can depend on it.

// 2027-01-01 00:00 Pacific is 08:00 UTC (PST, UTC−8).
const SEASON_END_ISO = "2027-01-01T08:00:00Z";

// Local preview only: SEASON_END_OVERRIDE=<ISO timestamp> ends the season at
// that instant, so the post-season site can be seen now against a real DB.
// Never set it in prod — it moves the finish line.
const override = process.env.SEASON_END_OVERRIDE;
if (override && Number.isNaN(Date.parse(override))) {
  throw new Error(`SEASON_END_OVERRIDE is not a timestamp: ${override}`);
}

export const SEASON_END = new Date(override || SEASON_END_ISO);

// The same instant in hotdog_events' own format ("YYYY-MM-DD HH:MM:SS", UTC),
// for binding into SQL.
export const SEASON_END_SQL = SEASON_END.toISOString().slice(0, 19).replace("T", " ");

// The last Pacific day of the season, as a date key.
export const SEASON_LAST_DAY_KEY = new Date(SEASON_END.getTime() - 1)
  .toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

export function isSeasonOver(now = new Date()) {
  return now.getTime() >= SEASON_END.getTime();
}

// "Now", as far as the competition is concerned: the real clock during the
// season, then pinned to its final instant forever. Anything that counts back
// from today — current streaks, heatmap windows, per-day averages, the pace —
// reads this, so in 2027 the site shows how 2026 *ended* rather than drifting
// into empty weeks and streaks that all read zero. GlizzyClicker uses the real
// clock; it has no end.
export function seasonNow(now = new Date()) {
  return isSeasonOver(now) ? new Date(SEASON_END.getTime() - 1) : now;
}
