import { getStats } from "./stats.js";
import { getLeaderboardStmt, getAllEventsStmt } from "./database.js";

export function registerApi(app) {
  app.get("/api/test-stats", (req, res) => {
    const stats = getStats();
    return res.json(stats);
  });

  // Simple API endpoint for external consumers to read the current hot dog totals
  // Simple API endpoint for external consumers to read the current hot dog totals
  app.get("/api/hotdog-totals", (req, res) => {
    try {
      const rows = getLeaderboardStmt.all();
      return res.json(rows);
    } catch (err) {
      console.error("Error fetching hot dog totals:", err);
      return res.status(500).json({ error: "failed to fetch hot dog totals" });
    }
  });

  app.get("/api/hotdog-events", (req, res) => {
    try {
      const rows = getAllEventsStmt.all();
      return res.json(rows);
    } catch (err) {
      console.error("Error fetching hot dog events:", err);
      return res.status(500).json({ error: "failed to fetch hot dog events" });
    }
  });

  // Export database file endpoint
  // Export database file endpoint
  app.get("/api/export-database", (req, res) => {
    try {
      const dbPath = "/database/data.db";
      res.download(dbPath, "hotdog-data.db", (err) => {
        if (err) {
          console.error("Error downloading database:", err);
          if (!res.headersSent) {
            return res.status(500).json({ error: "failed to export database" });
          }
        }
      });
    } catch (err) {
      console.error("Error exporting database:", err);
      return res.status(500).json({ error: "failed to export database" });
    }
  });
}
