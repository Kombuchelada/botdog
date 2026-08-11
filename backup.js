import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { unlinkSync, mkdtempSync, rmdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { db } from "./database.js";
import {
  uploadObject,
  listObjects,
  deleteObjects,
  isSpacesConfigured,
} from "./do-spaces.js";

const gzipAsync = promisify(gzip);

const BACKUP_INTERVAL_MS = 30 * 60 * 1000;      // every 30 minutes
const INITIAL_DELAY_MS = 30 * 1000;             // 30s after boot

// Retention. Everything inside the window is kept as-is; beyond it only the
// first snapshot of each UTC day survives. That caps the half-hourly flood
// (48/day) at a bounded steady state while leaving a daily trail going back
// forever — including the pre-existing daily history, which a naive
// "delete anything older than N days" would have wiped on its first run.
const RETAIN_ALL_MS = 7 * 24 * 60 * 60 * 1000;  // keep every snapshot for 7d

function log(...args) {
  console.log("[backup]", ...args);
}
function warn(...args) {
  console.warn("[backup]", ...args);
}

let lastBackupResult = null;

/**
 * Take a hot-safe snapshot of the SQLite DB, gzip it, and upload to DO Spaces.
 * Writes two objects:
 *   backups/db-{ISO}.db.gz   - timestamped, for retention
 *   backups/latest.db.gz     - overwritten each run, for easy restore
 * then applies the retention policy (see pruneBackups).
 */
export async function runBackup() {
  if (!isSpacesConfigured()) {
    throw new Error("DO Spaces is not configured (missing DO_SPACES_* env vars)");
  }
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "dbbackup-"));
  const tmpPath = path.join(tmpDir, "snapshot.db");
  const startedAt = Date.now();
  try {
    await db.backup(tmpPath);
    // Both of these are async on purpose. The sync versions block the event
    // loop for the whole read + compress, which was a shrug once a day and is
    // not at 48 times a day: GlizzyBrawl's Arena steps at 30Hz, so a stall
    // drops ticks for everyone connected. Async zlib runs on libuv's
    // threadpool, so level 9 costs the event loop nothing and we keep the
    // smaller object.
    const raw = await readFile(tmpPath);
    const gz = await gzipAsync(raw, { level: 9 });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "").slice(0, 19) + "Z";
    const tsKey = `backups/db-${ts}.db.gz`;
    const latestKey = `backups/latest.db.gz`;
    const [tsUrl, latestUrl] = await Promise.all([
      uploadObject(tsKey, gz, "application/gzip"),
      uploadObject(latestKey, gz, "application/gzip"),
    ]);
    const elapsedMs = Date.now() - startedAt;
    const result = {
      ok: true,
      timestamp: ts,
      timestamped_url: tsUrl,
      latest_url: latestUrl,
      original_bytes: raw.length,
      compressed_bytes: gz.length,
      elapsed_ms: elapsedMs,
    };
    lastBackupResult = result;
    log(`uploaded ${gz.length}B (compressed from ${raw.length}B, ratio ${(gz.length/raw.length*100).toFixed(1)}%) to ${tsKey} in ${elapsedMs}ms`);
    // Pruning is deliberately after the upload and swallows its own errors: a
    // failure to tidy old snapshots must never fail the backup that just
    // succeeded, which is the only part that protects anything.
    try {
      const pruned = await pruneBackups();
      if (pruned.deleted) log(`pruned ${pruned.deleted} old snapshot(s), ${pruned.kept} remain`);
      result.pruned = pruned.deleted;
    } catch (e) {
      warn("prune failed (backup itself was fine):", e.message);
    }
    return result;
  } finally {
    try { unlinkSync(tmpPath); } catch {}
    try { rmdirSync(tmpDir); } catch {}
  }
}

/**
 * Apply the retention policy to `backups/db-*`.
 *
 * Note the prefix: `backups/latest.db.gz` does not match `backups/db-` and so
 * is structurally out of reach here. That is the point — `latest` is the key
 * the restore recipe names, and it must not depend on a policy decision.
 */
export async function pruneBackups() {
  const objects = await listObjects("backups/db-");
  const doomed = selectExpired(objects, Date.now());
  const deleted = await deleteObjects(doomed);
  return { deleted, kept: objects.length - deleted };
}

/**
 * The retention decision, as a pure function: given the listing and a clock,
 * return the keys that should go. No network, no deletes — so it can be tested
 * and dry-run against the real bucket without risking anything.
 *
 * Keep every snapshot newer than RETAIN_ALL_MS; beyond that keep the first of
 * each UTC day. Anything without a usable timestamp is kept: this function
 * only ever deletes on positive evidence.
 */
export function selectExpired(objects, now) {
  const cutoff = now - RETAIN_ALL_MS;
  const keptPerDay = new Map(); // "YYYY-MM-DD" -> the earliest object that day
  const doomed = [];

  for (const o of objects) {
    const t = o.lastModified ? new Date(o.lastModified).getTime() : NaN;
    if (!Number.isFinite(t) || t >= cutoff) continue;
    const day = new Date(t).toISOString().slice(0, 10);
    const incumbent = keptPerDay.get(day);
    if (!incumbent) {
      keptPerDay.set(day, { key: o.key, t });
      continue;
    }
    if (t < incumbent.t) {
      keptPerDay.set(day, { key: o.key, t });
      doomed.push(incumbent.key);
    } else {
      doomed.push(o.key);
    }
  }
  return doomed;
}

export function getLastBackupResult() {
  return lastBackupResult;
}

export function startBackups() {
  if (!isSpacesConfigured()) {
    log("DO Spaces not configured; backups disabled");
    return;
  }
  log(`scheduling backups every ${BACKUP_INTERVAL_MS / 3600000}h, first run in ${INITIAL_DELAY_MS / 1000}s`);
  setTimeout(() => {
    runBackup().catch((e) => warn("initial backup failed:", e.message));
  }, INITIAL_DELAY_MS);
  setInterval(() => {
    runBackup().catch((e) => warn("scheduled backup failed:", e.message));
  }, BACKUP_INTERVAL_MS);
}
