// The competition ends; GlizzyClicker doesn't.
//
// Every public number reads the season (season.js); the game reads every row
// ever logged. Both halves fail silently if crossed: a 2027 dog quietly moving
// the frozen 2026 standings looks like a normal leaderboard, and a game that
// stopped seeing new dogs looks like a player who stopped eating.
//
// The season end is pinned with SEASON_END_OVERRIDE so the suite behaves the
// same whenever it runs. database.js reads it at import, so it's set first.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "season-test-"));
process.env.DB_PATH = join(dir, "test.db");
// Midnight Pacific (PDT) on 2026-06-01.
process.env.SEASON_END_OVERRIDE = "2026-06-01T07:00:00Z";

const {
  db,
  getUserTotalStmt,
  getLeaderboardStmt,
  getTotalHotdogsStmt,
  getAllEventsStmt,
  getLifetimeUserTotalStmt,
} = await import("../database.js");
const { isSeasonOver, SEASON_LAST_DAY_KEY, SEASON_END_SQL } = await import("../season.js");
const { computeBonuses } = await import("../glizzy.js");

const insert = db.prepare(
  "INSERT INTO hotdog_events (user_id, username, amount, timestamp) VALUES (?, ?, ?, ?)",
);

// Last minute of the season, and the first minute after it.
insert.run("a", "a", 60, "2026-06-01 06:59:59");
insert.run("b", "b", 50, "2026-05-15 12:00:00");
insert.run("b", "b", 50, "2026-06-01 07:00:00");
// An ISO-format row after the end must not sneak in on string comparison
// ("T" sorts after " ").
insert.run("a", "a", 1, "2026-06-01T07:00:01");

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("the season ends at midnight Pacific on the override instant", () => {
  assert.equal(SEASON_END_SQL, "2026-06-01 07:00:00");
  assert.equal(SEASON_LAST_DAY_KEY, "2026-05-31");
  assert.equal(isSeasonOver(new Date("2026-06-01T06:59:59Z")), false);
  assert.equal(isSeasonOver(new Date("2026-06-01T07:00:00Z")), true);
});

test("dogs logged after the season don't move the standings", () => {
  const board = getLeaderboardStmt.all().map((r) => [r.user_id, r.total_count]);
  assert.deepEqual(board, [["a", 60], ["b", 50]]);
  assert.equal(getTotalHotdogsStmt.get().total_hotdogs, 110);
  assert.equal(getUserTotalStmt.get("b").total_count, 50);
  assert.equal(getAllEventsStmt.all().length, 2);
});

test("GlizzyClicker still counts every dog, season or not", () => {
  assert.equal(getLifetimeUserTotalStmt.get("b").total_count, 100);
  // 100 lifetime dogs is Centurion; 50 in-season would not be.
  const ids = computeBonuses("b").map((bonus) => bonus.id);
  assert.ok(ids.includes("centurion"), `expected centurion in ${ids}`);
});
