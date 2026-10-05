// A slow reply makes Discord show "The application did not respond" after the
// row is already inserted, and the user re-runs /hotdog — one meal, two rows.
// findRecentDuplicate decides when /hotdog asks before logging.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "hotdog-guard-test-"));
process.env.DB_PATH = join(dir, "test.db");

const { db } = await import("../database.js");
const { findRecentDuplicate, DUPLICATE_WINDOW_MS } = await import("../hotdog-guard.js");

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// The 2026-10-03 case: 4 dogs at 21:18:47 UTC, the retry at 21:19:01.
const previous = { id: 1537, amount: 4, timestamp: "2026-10-03 21:18:47" };
const retryAt = new Date("2026-10-03T21:19:01Z");

test("the same amount moments later is flagged", () => {
  assert.equal(findRecentDuplicate(previous, 4, retryAt), previous);
});

test("a different amount is a different meal", () => {
  assert.equal(findRecentDuplicate(previous, 1, retryAt), null);
});

test("the same amount after the window is a new meal", () => {
  const later = new Date(Date.parse("2026-10-03T21:18:47Z") + DUPLICATE_WINDOW_MS);
  assert.equal(findRecentDuplicate(previous, 4, later), null);
});

test("no previous event means nothing to duplicate", () => {
  assert.equal(findRecentDuplicate(undefined, 4, retryAt), null);
});
