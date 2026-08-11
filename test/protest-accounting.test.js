// Protests must actually take the dogs back.
//
// A protest is a free-floating negative row filed at protest time — it doesn't
// retract the submission it disputes, and nothing links the two. So every
// consumer that reads raw rows sees the meal that was argued away, and none of
// them throws when it gets this wrong: a phantom Big Eater ×100 and a phantom
// single-sitting record both look exactly like a real one.
//
// stats.js and glizzy.js reach the DB at import time, so DB_PATH points at a
// scratch file before any import.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "protest-test-"));
process.env.DB_PATH = join(dir, "test.db");

const { db } = await import("../database.js");
const { buildUserMaxSittingMap, toPacificDateKey } = await import("../stats.js");
const { computeBonuses } = await import("../glizzy.js");

const EATER = "eater";
const CLEAN = "clean-eater";

const insert = db.prepare(
  "INSERT INTO hotdog_events (user_id, username, amount, timestamp) VALUES (?, ?, ?, ?)",
);

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A UTC timestamp string (the format the events table stores) for a given
 * Pacific hour on the Pacific day `daysAgo` days back. Pacific is UTC-7 or -8;
 * resolving it by search rather than by a fixed offset keeps the test honest
 * across DST, since toPacificDateKey/pacificHour are the things under test.
 */
function pacificStamp(daysAgo, pacificHour) {
  const targetDay = toPacificDateKey(new Date(Date.now() - daysAgo * 86400000));
  for (let offset = 7; offset <= 8; offset++) {
    const utc = new Date(`${targetDay}T00:00:00Z`);
    utc.setUTCHours(pacificHour + offset);
    if (toPacificDateKey(utc) === targetDay) {
      return utc.toISOString().replace("T", " ").slice(0, 19);
    }
  }
  throw new Error(`no UTC instant maps to ${targetDay} ${pacificHour}:00 Pacific`);
}

before(() => {
  // Yesterday: 5 dogs at 7 AM, the whole meal protested away that evening.
  insert.run(EATER, "eater", 5, pacificStamp(1, 7));
  insert.run(EATER, "eater", -5, pacificStamp(1, 20));
  // A day two weeks back that stands, so the user has a real record to hold.
  insert.run(EATER, "eater", 2, pacificStamp(14, 12));

  // Someone whose morning meal was only partly protested.
  insert.run(CLEAN, "clean-eater", 6, pacificStamp(1, 7));
  insert.run(CLEAN, "clean-eater", -1, pacificStamp(1, 20));
});

// ---------------------------------------------------------------------------
// GlizzyClicker bonuses
// ---------------------------------------------------------------------------

test("a day protested back to zero grants no Big Eater and no Breakfast Boon", () => {
  const ids = computeBonuses(EATER).map((b) => b.id);
  assert.ok(!ids.includes("big_eater"), "Big Eater paid out on a meal that was taken back");
  assert.ok(!ids.includes("breakfast_boon"), "Breakfast Boon paid out on a 7 AM dog that was taken back");
});

test("a partly protested day keeps its boons and counts the net", () => {
  const bonuses = computeBonuses(CLEAN);
  const big = bonuses.find((b) => b.id === "big_eater");
  assert.ok(big, "5 net dogs is still more than 4");
  assert.match(big.explanation, /\b5 dogs\b/, "Big Eater must report the net, not the gross 6");
  assert.ok(bonuses.some((b) => b.id === "breakfast_boon"), "the 7 AM dog partly stands");
});

// ---------------------------------------------------------------------------
// The single-sitting record
// ---------------------------------------------------------------------------

test("a sitting protested away doesn't hold the single-sitting record", () => {
  const maxByUser = buildUserMaxSittingMap(db.prepare("SELECT * FROM hotdog_events").all());
  assert.equal(maxByUser.get(EATER), 2, "the 5 was argued away; the surviving 2 is the record");
});

test("a partly protested sitting is capped at its day's net", () => {
  const maxByUser = buildUserMaxSittingMap(db.prepare("SELECT * FROM hotdog_events").all());
  assert.equal(maxByUser.get(CLEAN), 5, "6 logged, 1 protested — the sitting is worth 5");
});
