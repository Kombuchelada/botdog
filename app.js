import "dotenv/config";
import express from "express";
import { registerInteractions } from "./interactions.js";
import { registerApi } from "./api.js";
import { registerAdmin } from "./admin.js";

// Create an express app
const app = express();
// Get port, or default to 3000
const PORT = process.env.PORT || 3000;

registerInteractions(app);
registerApi(app);
registerAdmin(app);

app.listen(PORT, () => {
  console.log("Listening on port", PORT);
});
