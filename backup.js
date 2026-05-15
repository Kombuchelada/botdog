import { gzipSync } from "node:zlib";
import { readFileSync, unlinkSync, mkdtempSync, rmdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { db } from "./database.js";
import { uploadObject, isSpacesConfigured } from "./do-spaces.js";

const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const INITIAL_DELAY_MS = 30 * 1000;             // 30s after boot

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
    const raw = readFileSync(tmpPath);
    const gz = gzipSync(raw, { level: 9 });
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
    return result;
  } finally {
    try { unlinkSync(tmpPath); } catch {}
    try { rmdirSync(tmpDir); } catch {}
  }
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
