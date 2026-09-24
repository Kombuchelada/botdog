// The year-end awards are handed out once and announced to everyone, so a
// wrong winner is a public mistake with no second draw. These pin the rules
// most likely to be got wrong quietly: protests take trophies back, ties share,
// the hour-of-day awards use Pacific time, and the late-entry cutoff is a
// Pacific day.
//
// computeAwards is pure, but stats.js reaches the DB at import time, so
// DB_PATH points at a scratch file first.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "awards-test-"));
process.env.DB_PATH = join(dir, "test.db");
after(() => rmSync(dir, { recursive: true, force: true }));

const { computeAwards } = await import("../awards.js");

// Timestamps are UTC, like the table. In June, Pacific is UTC−7.
const ev = (user_id, amount, timestamp) => ({ user_id, amount, timestamp });
const award = (result, id) => result.awards.find((a) => a.id === id);

test("a sitting protested away doesn't win Big Sitting", () => {
  const r = computeAwards([
    ev("liar", 12, "2026-06-10 19:00:00"),
    ev("liar", -12, "2026-06-10 21:00:00"),
    ev("liar", 1, "2026-06-11 19:00:00"),
    ev("honest", 5, "2026-06-10 19:00:00"),
  ]);
  assert.deepEqual(award(r, "big_sitting").userIds, ["honest"]);
  assert.equal(award(r, "big_sitting").value, 5);
  assert.deepEqual(award(r, "most_protested").userIds, ["liar"]);
  assert.equal(award(r, "most_protested").value, 12);
});

test("ties share an award and a podium place", () => {
  const r = computeAwards([
    ev("a", 10, "2026-06-10 19:00:00"),
    ev("b", 10, "2026-06-10 19:00:00"),
    ev("c", 4, "2026-06-10 19:00:00"),
  ]);
  assert.deepEqual(award(r, "champion").userIds, ["a", "b"]);
  // Two share first, so the next place is third, not second.
  assert.equal(award(r, "second"), undefined);
  assert.deepEqual(award(r, "third").userIds, ["c"]);
});

test("Early Bird and Night Owl read the Pacific hour", () => {
  const r = computeAwards([
    // 07:30 Pacific = 14:30 UTC — early. 14:30 UTC is not early in UTC terms.
    ev("early", 3, "2026-06-10 14:30:00"),
    // 22:30 Pacific = 05:30 UTC the next day — late.
    ev("late", 2, "2026-06-11 05:30:00"),
    // 12:00 Pacific — neither.
    ev("noon", 9, "2026-06-10 19:00:00"),
  ]);
  assert.deepEqual(award(r, "early_bird").userIds, ["early"]);
  assert.deepEqual(award(r, "night_owl").userIds, ["late"]);
});

test("Best Late Entry counts people whose first day is March 1 Pacific or later", () => {
  const r = computeAwards([
    // 23:30 Pacific on Feb 28 (UTC−8) — that's 07:30 UTC on March 1, but Feb 28 in Pacific.
    ev("feb", 50, "2026-03-01 07:30:00"),
    // 00:30 Pacific on March 1.
    ev("march", 20, "2026-03-01 08:30:00"),
  ]);
  assert.deepEqual(award(r, "late_entry").userIds, ["march"]);
});

test("nobody wins with a zero", () => {
  const r = computeAwards([ev("a", 3, "2026-06-10 19:00:00")]);
  assert.equal(award(r, "most_protested"), undefined);
  assert.equal(award(r, "early_bird"), undefined);
});
