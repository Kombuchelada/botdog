import "dotenv/config";
import express from "express";
import { registerInteractions } from "./interactions.js";
import { registerApi } from "./api.js";
import { registerAdmin } from "./admin.js";
import { registerDashboard } from "./dashboard.js";
import { startArchive } from "./archive.js";
import { startBackups } from "./backup.js";

// Create an express app
const app = express();
// Get port, or default to 3000
const PORT = process.env.PORT || 3000;

registerInteractions(app);
registerApi(app);
registerAdmin(app);
registerDashboard(app);

app.listen(PORT, () => {
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
