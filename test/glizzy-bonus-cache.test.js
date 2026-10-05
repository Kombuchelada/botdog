// computeBonuses is cached per user (deriving it scans the whole hot dog log,
// and doing that on every save stalled the bot). A cache that misses a change
// pays a bonus for dogs that were deleted or protested — and like every
// phantom bonus here, it throws nothing. The rows below go in through raw SQL
// on purpose: invalidation must not depend on which code path wrote.
//
// glizzy.js reaches the DB at import time, so DB_PATH points at a scratch file
// before any import.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "bonus-cache-test-"));
process.env.DB_PATH = join(dir, "test.db");

const { db } = await import("../database.js");
const { computeBonuses } = await import("../glizzy.js");

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const USER = "cached-eater";
const ids = () => computeBonuses(USER).map((b) => b.id);

test("every kind of write to the log invalidates the cached bonuses", () => {
  const { lastInsertRowid } = db
    .prepare("INSERT INTO hotdog_events (user_id, username, amount, timestamp) VALUES (?, ?, ?, ?)")
    .run(USER, "c", 100, "2026-01-15 20:00:00");
  assert.ok(ids().includes("centurion"), "insert");

  db.prepare("UPDATE hotdog_events SET amount = 99 WHERE id = ?").run(lastInsertRowid);
  assert.ok(!ids().includes("centurion"), "update");

  db.prepare("UPDATE hotdog_events SET amount = 100 WHERE id = ?").run(lastInsertRowid);
  assert.ok(ids().includes("centurion"), "update back");

  db.prepare("DELETE FROM hotdog_events WHERE id = ?").run(lastInsertRowid);
  assert.ok(!ids().includes("centurion"), "delete");
});

test("callers can't corrupt the cache by mutating what they get back", () => {
  db.prepare("INSERT INTO hotdog_events (user_id, username, amount, timestamp) VALUES (?, ?, ?, ?)")
    .run(USER, "c", 100, "2026-01-16 20:00:00");
  const first = computeBonuses(USER);
  first[0].effect.value = 0;
  first.length = 0;
  const again = computeBonuses(USER).find((b) => b.id === "centurion");
  assert.equal(again.effect.value, 2);
});
