// The finale runs once, in public, at a moment nobody will be watching the
// logs. These pin the two ways it can go wrong without throwing: posting
// early (or twice — the check runs every minute, across deploys) and not
// posting at all because one failed step took the others down with it.
//
// Discord is the outside world here, so fetch is stubbed; the clock is an
// argument to runFinaleIfDue, and the season end is pinned with
// SEASON_END_OVERRIDE before anything imports season.js.

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "finale-test-"));
process.env.DB_PATH = join(dir, "test.db");
process.env.SEASON_END_OVERRIDE = "2026-06-01T07:00:00Z";
process.env.DISCORD_TOKEN = "test-token";
process.env.ARCHIVE_ANNOUNCE_CHANNEL_ID = "chan";
delete process.env.ANTHROPIC_API_KEY; // the Year in Review must be skipped, not attempted

const { db, getArchiveState } = await import("../database.js");
const { runFinaleIfDue } = await import("../finale.js");

const SEASON_END = Date.parse("2026-06-01T07:00:00Z");
const insert = db.prepare(
  "INSERT INTO hotdog_events (user_id, username, amount, timestamp) VALUES (?, ?, ?, ?)",
);
insert.run("champ", "champ", 10, "2026-05-20 19:00:00");
insert.run("second", "second", 4, "2026-05-20 19:00:00");
// Logged after the season: must not appear in the results.
insert.run("second", "second", 50, "2026-06-02 19:00:00");

let posts = [];
let failDiscord = false;
globalThis.fetch = async (url, options) => {
  if (failDiscord) return new Response(JSON.stringify({ message: "down" }), { status: 503 });
  posts.push({ url: String(url), body: JSON.parse(options.body) });
  return new Response("{}", { status: 200 });
};

beforeEach(() => {
  posts = [];
  failDiscord = false;
  db.prepare("DELETE FROM archive_state WHERE key LIKE 'finale_%'").run();
});

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("nothing happens before 12:01 AM Pacific", async () => {
  await runFinaleIfDue(SEASON_END - 1000);
  await runFinaleIfDue(SEASON_END + 59 * 1000);
  assert.equal(posts.length, 0);
});

test("the results post once, with the season's champion", async () => {
  await runFinaleIfDue(SEASON_END + 60 * 1000);
  await runFinaleIfDue(SEASON_END + 120 * 1000);
  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /channels\/chan\/messages$/);
  assert.match(posts[0].body.content, /<@champ>/);
  const standings = posts[0].body.embeds[0].fields[0].value;
  assert.match(standings, /1\. <@champ> — \*\*10\*\*/);
  assert.match(standings, /2\. <@second> — \*\*4\*\*/);
});

test("a Discord outage is retried on the next check rather than lost", async () => {
  failDiscord = true;
  await runFinaleIfDue(SEASON_END + 60 * 1000);
  assert.equal(getArchiveState("finale_announced_at"), null);
  failDiscord = false;
  await runFinaleIfDue(SEASON_END + 120 * 1000);
  assert.equal(posts.length, 1);
});

test("with no API key the Year in Review is skipped without an attempt", async () => {
  await runFinaleIfDue(SEASON_END + 60 * 1000);
  assert.equal(getArchiveState("year_in_review_attempts"), null);
});
