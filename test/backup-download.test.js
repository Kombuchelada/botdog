// The admin download route takes an object key from the query string and
// streams it out with the bucket's own credentials. `isBackupKey` is the only
// thing standing between that and "read any object in the bucket" — and a
// guard that lets too much through throws nothing and changes no page.
//
// Pure: no S3, no route. backup.js reaches database.js on import, so DB_PATH
// points somewhere disposable first.

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { rmSync } from "node:fs";

process.env.DB_PATH = path.join(os.tmpdir(), `backup-download-test-${process.pid}.db`);
const { isBackupKey } = await import("../backup.js");

process.on("exit", () => {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    try { rmSync(process.env.DB_PATH + suffix); } catch {}
  }
});

test("snapshots and latest can be downloaded", () => {
  assert.equal(isBackupKey("backups/latest.db.gz"), true);
  assert.equal(isBackupKey("backups/db-2026-09-24T21-50-38Z.db.gz"), true);
});

test("nothing outside backups/ can be named", () => {
  for (const key of [
    "attachments/123/photo.jpg",
    "avatars/1-abc.png",
    "backups/../attachments/123/photo.jpg",
    "backups/db-x/../../avatars/1.png",
    "backups/",
    "backups/latest.db",
    "latest.db.gz",
    "",
    undefined,
  ]) {
    assert.equal(isBackupKey(key), false, `accepted ${JSON.stringify(key)}`);
  }
});
