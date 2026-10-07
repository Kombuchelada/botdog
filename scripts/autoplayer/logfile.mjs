// The Autoplayer's log file: one current file, rolled over when it reaches
// `maxBytes` or the local date changes, with each rolled file gzipped and only
// the newest `keep` archives kept.
//
//   <dir>/autoplayer.log                        ← being written
//   <dir>/autoplayer-2026-10-07T15-32-40.log.gz ← rolled, newest `keep` kept
//
// Writes are synchronous appends, so a crash loses nothing that was logged.
// Compression is async and off the write path; a crash mid-gzip leaves the
// plain rolled .log behind, which the next start compresses.

import { appendFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

const CURRENT = "autoplayer.log";
const ROLLED = /^autoplayer-[\dT-]+\.log(\.gz)?$/;

const dayKey = (d) => d.toLocaleDateString("en-CA"); // local YYYY-MM-DD
const stamp = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 19).replace(/:/g, "-");

export function openLog(dir, { maxBytes = 10 * 1024 * 1024, keep = 30, now = () => new Date() } = {}) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, CURRENT);
  let size = 0;
  let day = dayKey(now());
  if (existsSync(path)) {
    const st = statSync(path);
    size = st.size;
    day = dayKey(st.mtime);
  }
  const pending = new Set();

  function compress(file) {
    const p = (async () => {
      const src = join(dir, file);
      await pipeline(createReadStream(src), createGzip({ level: 9 }), createWriteStream(src + ".gz"));
      unlinkSync(src);
      prune();
    })().catch(() => {}).finally(() => pending.delete(p));
    pending.add(p);
  }

  function prune() {
    const archives = readdirSync(dir).filter((f) => ROLLED.test(f) && f.endsWith(".gz")).sort();
    for (const f of archives.slice(0, Math.max(0, archives.length - keep))) {
      try { unlinkSync(join(dir, f)); } catch {}
    }
  }

  function roll(at) {
    if (!existsSync(path) || size === 0) return;
    let name = "autoplayer-" + stamp(at) + ".log";
    for (let i = 1; existsSync(join(dir, name)) || existsSync(join(dir, name + ".gz")); i++) {
      name = "autoplayer-" + stamp(at) + "-" + i + ".log";
    }
    renameSync(path, join(dir, name));
    size = 0;
    compress(name);
  }

  // Leftovers from a crash mid-compress.
  for (const f of readdirSync(dir)) if (ROLLED.test(f) && !f.endsWith(".gz")) compress(f);

  return {
    path,
    write(line) {
      const at = now();
      if (dayKey(at) !== day || size >= maxBytes) roll(at);
      day = dayKey(at);
      const data = line + "\n";
      appendFileSync(path, data);
      size += Buffer.byteLength(data);
    },
    // Resolves once any in-flight compression is done (tests, clean exit).
    flush: () => Promise.all([...pending]),
  };
}
