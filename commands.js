import "dotenv/config";
import { InstallGlobalCommands } from "./utils.js";

const HOTDOG_COMMAND = {
  name: "hotdog",
  description: "Add hot dogs",
  options: [
    {
      type: 4, // integer
      name: "amount",
      description: "Number of hot dogs to add",
      required: true,
    },
  ],
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1],
};

// Protest command: target a user and specify an amount to deduct if seconded
const PROTEST_COMMAND = {
  name: "protest",
  description: "Protest another user's hotdog claim",
  options: [
    {
      type: 6, // USER
      name: "user",
      description: "User to protest",
      required: true,
    },
    {
      type: 4, // INTEGER
      name: "amount",
      description: "Amount to deduct if seconded",
      required: true,
    },
  ],
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const LEADERBOARD_COMMAND = {
  name: "leaderboard",
  description: "View the hot dog leaderboard",
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const STATS_COMMAND = {
  name: "stats",
  description: "View server hot dog stats",
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const ALL_COMMANDS = [
  HOTDOG_COMMAND,
  PROTEST_COMMAND,
  LEADERBOARD_COMMAND,
  STATS_COMMAND,
];

InstallGlobalCommands(process.env.APP_ID, ALL_COMMANDS);
