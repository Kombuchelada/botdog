import "dotenv/config";
import express from "express";
import { registerInteractions } from "./interactions.js";
import { registerApi } from "./api.js";

// Create an express app
const app = express();
// Get port, or default to 3000
const PORT = process.env.PORT || 3000;

registerInteractions(app);
registerApi(app);

app.listen(PORT, () => {
  console.log("Listening on port", PORT);
});
