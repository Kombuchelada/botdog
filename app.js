import "dotenv/config";
import express from "express";
import { registerInteractions } from "./interactions.js";
import { registerApi } from "./api.js";
import { registerAdmin } from "./admin.js";
import { registerDashboard } from "./dashboard.js";
import { startArchive } from "./archive.js";
import { startBackups } from "./backup.js";
import { db } from "./database.js";

// Create an express app
const app = express();
// Get port, or default to 3000
const PORT = process.env.PORT || 3000;

registerInteractions(app);
registerApi(app);
registerAdmin(app);
registerDashboard(app);

const server = app.listen(PORT, () => {
  console.log("Listening on port", PORT);
  try {
    startArchive();
  } catch (err) {
    console.error("Failed to start archive worker:", err);
  }
  try {
    startBackups();
  } catch (err) {
    console.error("Failed to start backup worker:", err);
  }
});

// Graceful shutdown: when Railway deploys, it sends SIGTERM. Default Node
// behavior is to exit with code 143, which Railway counts as a crash. Drain
// in-flight HTTP requests, close the SQLite handle, and exit 0.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down gracefully...`);

  // Stop accepting new connections; existing ones get to finish.
  server.close((err) => {
    if (err) {
      console.error("Error closing HTTP server:", err);
    }
    try {
      db.close();
    } catch (dbErr) {
      console.error("Error closing DB:", dbErr);
    }
    console.log("Shutdown complete.");
    process.exit(0);
  });

  // If anything hangs (e.g., a Claude call mid-flight), force-exit before
  // Railway's grace period runs out so we still get a clean code, not a kill.
  setTimeout(() => {
    console.error("Shutdown timed out after 20s, forcing exit.");
    process.exit(0);
  }, 20_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
