import Database from "better-sqlite3";

// Initialize SQLite database for persistent hotdog tracking
const db = new Database("./database/data.db");

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
