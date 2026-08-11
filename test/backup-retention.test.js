// Backup retention — the only code in this repo that deletes durable data.
//
// A fifth seam, tested for the reason the audio and art ones are: it fails
// silently. A retention policy that is too aggressive does not throw, does not
// change a page, and does not show up until the day someone needs a snapshot
// that is no longer there. The bug it exists to prevent is specific and was
// live in the first draft of this feature: "delete anything older than N days"
// reads as obviously correct and would have destroyed three months of daily
// history on its first run, because the daily trail predates the half-hourly
// cadence the policy was written for.
//
// These tests only ever call the pure decision, `selectExpired(objects, now)`.
// Nothing here touches S3, and the clock is an argument rather than the wall,
// so there is no window in which this suite behaves differently.

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { rmSync } from "node:fs";

// backup.js reaches database.js on import, which opens SQLite at DB_PATH.
// Point it somewhere disposable before that import happens — the retention
// decision has nothing to do with the database, and shouldn't need a real one.
process.env.DB_PATH = path.join(os.tmpdir(), `backup-retention-test-${process.pid}.db`);
const { selectExpired } = await import("../backup.js");

// database.js keeps the handle open for the life of the process; unlinking the
// file underneath it is fine on POSIX and leaves no scratch DB in /tmp.
process.on("exit", () => {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    try { rmSync(process.env.DB_PATH + suffix); } catch {}
  }
});

const NOW = Date.parse("2026-08-11T12:00:00Z");
const obj = (key, iso) => ({ key, size: 1, lastModified: new Date(iso) });

test("keeps every snapshot inside the retention window", () => {
  // Same UTC day, three of them, all recent. The half-hourly cadence means
  // this is the normal case, not an edge one.
  const objects = [
    obj("backups/db-a.db.gz", "2026-08-10T01:00:00Z"),
    obj("backups/db-b.db.gz", "2026-08-10T01:30:00Z"),
    obj("backups/db-c.db.gz", "2026-08-10T02:00:00Z"),
  ];
  assert.deepEqual(selectExpired(objects, NOW), []);
});

test("beyond the window, keeps the first snapshot of each UTC day", () => {
  const objects = [
    obj("backups/db-noon.db.gz", "2026-07-01T12:00:00Z"),
    obj("backups/db-early.db.gz", "2026-07-01T01:00:00Z"),
    obj("backups/db-late.db.gz", "2026-07-01T23:00:00Z"),
  ];
  const doomed = selectExpired(objects, NOW);
  assert.deepEqual(doomed.sort(), ["backups/db-late.db.gz", "backups/db-noon.db.gz"]);
  assert.ok(!doomed.includes("backups/db-early.db.gz"), "earliest of the day must survive");
});

test("a day with a single old snapshot is left alone", () => {
  const objects = [obj("backups/db-solo.db.gz", "2026-06-01T09:00:00Z")];
  assert.deepEqual(selectExpired(objects, NOW), []);
});

test("days are bucketed in UTC, not local time", () => {
  // Either side of midnight UTC: two distinct days, so both are first-of-day.
  const objects = [
    obj("backups/db-before.db.gz", "2026-07-01T23:30:00Z"),
    obj("backups/db-after.db.gz", "2026-07-02T00:30:00Z"),
  ];
  assert.deepEqual(selectExpired(objects, NOW), []);
});

test("never deletes an object whose timestamp is missing or unparseable", () => {
  // Retention deletes on positive evidence only. An object we cannot date is
  // one we cannot justify removing.
  const objects = [
    { key: "backups/db-undated.db.gz", size: 1 },
    { key: "backups/db-garbage.db.gz", size: 1, lastModified: "not-a-date" },
    obj("backups/db-keeper.db.gz", "2026-07-01T01:00:00Z"),
    obj("backups/db-surplus.db.gz", "2026-07-01T02:00:00Z"),
  ];
  const doomed = selectExpired(objects, NOW);
  assert.deepEqual(doomed, ["backups/db-surplus.db.gz"]);
});

test("empty listing selects nothing", () => {
  assert.deepEqual(selectExpired([], NOW), []);
});

test("the whole history collapses to one per day, not to nothing", () => {
  // The regression guard. 90 days of 48 snapshots each, all outside the
  // window: exactly 90 survive, one per day — never zero.
  const objects = [];
  for (let d = 0; d < 90; d++) {
    const day = new Date(Date.parse("2026-01-01T00:00:00Z") + d * 86400000);
    for (let h = 0; h < 48; h++) {
      objects.push(obj(`backups/db-${d}-${h}.db.gz`, new Date(day.getTime() + h * 1800000).toISOString()));
    }
  }
  const doomed = selectExpired(objects, NOW);
  assert.equal(objects.length - doomed.length, 90);
});
