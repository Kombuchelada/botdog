import Database from "better-sqlite3";

// Initialize SQLite database for persistent hotdog tracking
const db = new Database(process.env.DB_PATH || "/database/data.db");
export { db };

// Create table to track each hotdog addition event
db.prepare(
  `CREATE TABLE IF NOT EXISTS hotdog_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    amount INTEGER NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
).run();

// Create view to get current hotdog count per user
db.prepare(
  `CREATE VIEW IF NOT EXISTS hotdog_totals AS
   SELECT user_id, username, SUM(amount) as total_count
   FROM hotdog_events
   GROUP BY user_id`,
).run();

// Prepared statements
export const insertHotdogEventStmt = db.prepare(
  "INSERT INTO hotdog_events (user_id, username, amount) VALUES (?, ?, ?)",
);
export const getUserTotalStmt = db.prepare(
  "SELECT user_id, username, total_count FROM hotdog_totals WHERE user_id = ?",
);
export const getLeaderboardStmt = db.prepare(
  "SELECT user_id, username, total_count FROM hotdog_totals ORDER BY total_count DESC",
);
export const getTotalHotdogsStmt = db.prepare(
  "SELECT SUM(total_count) as total_hotdogs FROM hotdog_totals",
);
export const getAllEventsStmt = db.prepare(
  "SELECT * FROM hotdog_events ORDER BY timestamp DESC",
);
export const getLargestSingleSubmissionStmt = db.prepare(
  "SELECT * FROM hotdog_events ORDER BY amount DESC, timestamp DESC LIMIT 1",
);
export const getMaxSinglePerUserStmt = db.prepare(
  "SELECT user_id, MAX(amount) as max_single FROM hotdog_events GROUP BY user_id",
);
export const getAverageAmountPerEventStmt = db.prepare(
  "SELECT AVG(amount) as average_amount FROM hotdog_events",
);

// ============================================================================
// Archive feature: cached Discord messages, attachments, generated stories
// ============================================================================

db.prepare(
  `CREATE TABLE IF NOT EXISTS archive_messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    author_name TEXT NOT NULL,
    content TEXT,
    reply_to TEXT,
    created_at TEXT NOT NULL,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
).run();
db.prepare(
  `CREATE INDEX IF NOT EXISTS idx_archive_messages_created ON archive_messages(created_at)`,
).run();

db.prepare(
  `CREATE TABLE IF NOT EXISTS archive_attachments (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    original_url TEXT NOT NULL,
    spaces_key TEXT NOT NULL,
    public_url TEXT NOT NULL,
    content_type TEXT,
    size_bytes INTEGER,
    width INTEGER,
    height INTEGER,
    FOREIGN KEY (message_id) REFERENCES archive_messages(id)
  )`,
).run();
db.prepare(
  `CREATE INDEX IF NOT EXISTS idx_archive_attachments_message ON archive_attachments(message_id)`,
).run();

db.prepare(
  `CREATE TABLE IF NOT EXISTS archive_stories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    hero_attachment_id TEXT,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    source_message_ids TEXT NOT NULL,
    generated_at TEXT NOT NULL DEFAULT (datetime('now')),
    model_id TEXT,
    manually_edited INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0
  )`,
).run();

db.prepare(
  `CREATE TABLE IF NOT EXISTS glizzy_game (
    user_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    lifetime_glizzies INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
).run();
db.prepare(
  `CREATE INDEX IF NOT EXISTS idx_glizzy_lifetime ON glizzy_game(lifetime_glizzies DESC)`,
).run();

export const upsertGameStateStmt = db.prepare(
  `INSERT INTO glizzy_game (user_id, state, lifetime_glizzies)
   VALUES (?, ?, ?)
   ON CONFLICT(user_id) DO UPDATE SET
     state = excluded.state,
     lifetime_glizzies = MAX(glizzy_game.lifetime_glizzies, excluded.lifetime_glizzies),
     updated_at = datetime('now')`,
);
export const getGameStateStmt = db.prepare(
  "SELECT * FROM glizzy_game WHERE user_id = ?",
);
export const topByLifetimeStmt = db.prepare(
  "SELECT user_id, state, lifetime_glizzies, updated_at FROM glizzy_game ORDER BY lifetime_glizzies DESC LIMIT ?",
);

// ============================================================================
// GlizzyBrawl: the Arena ledger.
//
// One row per player, ever. There is deliberately no match/bout/win concept to
// hang a row on (see docs/adr/0001-continuous-arena.md) — the Arena never
// concludes, so the only things worth remembering are cumulative. Rows are
// written at KO / despawn / disconnect time, never per tick.
// `day_key` + `day_kos` + `day_falls` carry the Pacific Day Tally; they are
// reset lazily the first time a player scores on a new Pacific day.
// ============================================================================

db.prepare(
  `CREATE TABLE IF NOT EXISTS brawl_stats (
    user_id TEXT PRIMARY KEY,
    kos INTEGER NOT NULL DEFAULT 0,
    falls INTEGER NOT NULL DEFAULT 0,
    best_streak INTEGER NOT NULL DEFAULT 0,
    arena_seconds INTEGER NOT NULL DEFAULT 0,
    character_kos TEXT NOT NULL DEFAULT '{}',
    day_key TEXT,
    day_kos INTEGER NOT NULL DEFAULT 0,
    day_falls INTEGER NOT NULL DEFAULT 0,
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
).run();
db.prepare(
  `CREATE INDEX IF NOT EXISTS idx_brawl_kos ON brawl_stats(kos DESC)`,
).run();

export const getBrawlStatsStmt = db.prepare(
  "SELECT * FROM brawl_stats WHERE user_id = ?",
);
export const ensureBrawlStatsStmt = db.prepare(
  "INSERT OR IGNORE INTO brawl_stats (user_id) VALUES (?)",
);
export const updateBrawlStatsStmt = db.prepare(
  `UPDATE brawl_stats SET
     kos = ?, falls = ?, best_streak = ?, arena_seconds = ?, character_kos = ?,
     day_key = ?, day_kos = ?, day_falls = ?, last_seen_at = datetime('now')
   WHERE user_id = ?`,
);
export const topBrawlersStmt = db.prepare(
  // A row exists from the moment someone joins the Arena, so a board that
  // didn't filter would be padded with 0/0 rows for everyone who ever looked in.
  `SELECT * FROM brawl_stats WHERE kos > 0 OR falls > 0
   ORDER BY kos DESC, falls ASC LIMIT ?`,
);
export const topBrawlersTodayStmt = db.prepare(
  `SELECT * FROM brawl_stats WHERE day_key = ? AND (day_kos > 0 OR day_falls > 0)
   ORDER BY day_kos DESC, day_falls ASC LIMIT ?`,
);

db.prepare(
  `CREATE TABLE IF NOT EXISTS user_profiles (
    user_id TEXT PRIMARY KEY,
    username TEXT,
    global_name TEXT,
    avatar_hash TEXT,
    avatar_url TEXT,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
).run();

export const upsertUserProfileStmt = db.prepare(
  `INSERT INTO user_profiles (user_id, username, global_name, avatar_hash, avatar_url, fetched_at)
   VALUES (?, ?, ?, ?, ?, datetime('now'))
   ON CONFLICT(user_id) DO UPDATE SET
     username = excluded.username,
     global_name = excluded.global_name,
     avatar_hash = excluded.avatar_hash,
     avatar_url = excluded.avatar_url,
     fetched_at = datetime('now')`,
);
export const getUserProfileStmt = db.prepare(
  "SELECT * FROM user_profiles WHERE user_id = ?",
);
export const listUserProfilesStmt = db.prepare(
  "SELECT * FROM user_profiles",
);
export const listDistinctEventUserIdsStmt = db.prepare(
  "SELECT DISTINCT user_id FROM hotdog_events",
);

// Additive migration: existing deployments get tags column.
(function ensureStoriesTagsColumn() {
  const cols = db.prepare("PRAGMA table_info(archive_stories)").all();
  if (!cols.find((c) => c.name === "tags")) {
    db.prepare("ALTER TABLE archive_stories ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'").run();
  }
})();
db.prepare(
  `CREATE INDEX IF NOT EXISTS idx_archive_stories_period ON archive_stories(period_end DESC)`,
).run();

db.prepare(
  `CREATE TABLE IF NOT EXISTS archive_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
).run();

export const insertArchiveMessageStmt = db.prepare(
  `INSERT OR IGNORE INTO archive_messages (id, channel_id, author_id, author_name, content, reply_to, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);
export const insertArchiveAttachmentStmt = db.prepare(
  `INSERT OR IGNORE INTO archive_attachments (id, message_id, original_url, spaces_key, public_url, content_type, size_bytes, width, height)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
export const getArchiveAttachmentByIdStmt = db.prepare(
  `SELECT * FROM archive_attachments WHERE id = ?`,
);
export const getArchiveMessagesInRangeStmt = db.prepare(
  `SELECT * FROM archive_messages WHERE created_at >= ? AND created_at < ? ORDER BY created_at ASC`,
);
export const getArchiveAttachmentsForMessageStmt = db.prepare(
  `SELECT * FROM archive_attachments WHERE message_id = ?`,
);
export const getOldestArchiveMessageIdStmt = db.prepare(
  `SELECT id FROM archive_messages ORDER BY id ASC LIMIT 1`,
);
export const getNewestArchiveMessageIdStmt = db.prepare(
  `SELECT id FROM archive_messages ORDER BY id DESC LIMIT 1`,
);
export const countStoriesForPeriodStmt = db.prepare(
  `SELECT COUNT(*) AS c FROM archive_stories WHERE period_start = ? AND period_end = ?`,
);
export const insertArchiveStoryStmt = db.prepare(
  `INSERT INTO archive_stories (title, body, hero_attachment_id, period_start, period_end, source_message_ids, model_id, tags)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
);
export const listPublishedStoriesStmt = db.prepare(
  `SELECT * FROM archive_stories WHERE hidden = 0 ORDER BY period_end DESC, id DESC`,
);
export const listAllStoriesStmt = db.prepare(
  `SELECT * FROM archive_stories ORDER BY period_end DESC, id DESC`,
);
export const getStoryByIdStmt = db.prepare(
  `SELECT * FROM archive_stories WHERE id = ?`,
);
export const updateStoryStmt = db.prepare(
  `UPDATE archive_stories SET title = ?, body = ?, hero_attachment_id = ?, tags = ?, manually_edited = 1 WHERE id = ?`,
);
export const setStoryHiddenStmt = db.prepare(
  `UPDATE archive_stories SET hidden = ? WHERE id = ?`,
);
export const deleteStoryStmt = db.prepare(
  `DELETE FROM archive_stories WHERE id = ?`,
);
export const replaceStoryContentStmt = db.prepare(
  `UPDATE archive_stories SET title = ?, body = ?, hero_attachment_id = ?, source_message_ids = ?, model_id = ?, tags = ?, manually_edited = 0, generated_at = datetime('now') WHERE id = ?`,
);
export const getArchiveStateStmt = db.prepare(
  `SELECT value FROM archive_state WHERE key = ?`,
);
export const setArchiveStateStmt = db.prepare(
  `INSERT INTO archive_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
);

export function getArchiveState(key) {
  const row = getArchiveStateStmt.get(key);
  return row ? row.value : null;
}
export function setArchiveState(key, value) {
  setArchiveStateStmt.run(key, value);
}

// Admin-only prepared statements
export const getEventByIdStmt = db.prepare(
  "SELECT * FROM hotdog_events WHERE id = ?",
);
export const updateEventStmt = db.prepare(
  "UPDATE hotdog_events SET user_id = ?, username = ?, amount = ?, timestamp = ? WHERE id = ?",
);
export const deleteEventStmt = db.prepare(
  "DELETE FROM hotdog_events WHERE id = ?",
);
export const insertEventWithTimestampStmt = db.prepare(
  "INSERT INTO hotdog_events (user_id, username, amount, timestamp) VALUES (?, ?, ?, ?)",
);
