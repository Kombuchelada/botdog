// Autoplayer log-file rotation. The Autoplayer runs for weeks unattended, so
// a log that never rolls fills the disk, and a roll that loses lines loses the
// only record of what it did while nobody was watching.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { openLog } from "../scripts/autoplayer/logfile.mjs";

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "autoplayer-log-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Everything logged, current file plus every archive, in order.
function allLines(dir) {
  const files = readdirSync(dir).sort();
  const archives = files.filter((f) => f.endsWith(".gz")).map((f) => gunzipSync(readFileSync(join(dir, f))).toString());
  const current = files.includes("autoplayer.log") ? readFileSync(join(dir, "autoplayer.log"), "utf8") : "";
  return (archives.join("") + current).split("\n").filter(Boolean);
}

test("rolls and gzips at the size limit without losing a line", async (t) => {
  const dir = scratch(t);
  let clock = new Date("2026-10-07T12:00:00");
  const log = openLog(dir, { maxBytes: 100, now: () => clock });
  const written = [];
  for (let i = 0; i < 40; i++) {
    clock = new Date(clock.getTime() + 1000);
    const line = "line " + i + " " + "x".repeat(20);
    written.push(line);
    log.write(line);
  }
  await log.flush();
  assert.ok(readdirSync(dir).filter((f) => f.endsWith(".log.gz")).length > 1);
  assert.deepEqual(allLines(dir), written);
});

test("rolls when the local date changes", async (t) => {
  const dir = scratch(t);
  let clock = new Date("2026-10-07T23:59:58");
  const log = openLog(dir, { now: () => clock });
  log.write("tuesday");
  clock = new Date("2026-10-08T00:00:01");
  log.write("wednesday");
  await log.flush();
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".gz")).length, 1);
  assert.equal(readFileSync(join(dir, "autoplayer.log"), "utf8"), "wednesday\n");
});

test("keeps only the newest archives", async (t) => {
  const dir = scratch(t);
  let clock = new Date("2026-10-07T12:00:00");
  const log = openLog(dir, { maxBytes: 1, keep: 3, now: () => clock });
  for (let i = 0; i < 10; i++) {
    clock = new Date(clock.getTime() + 1000);
    log.write("line " + i);
    await log.flush();
  }
  const archives = readdirSync(dir).filter((f) => f.endsWith(".gz")).sort();
  assert.equal(archives.length, 3);
  assert.deepEqual(allLines(dir), ["line 6", "line 7", "line 8", "line 9"]);
});
