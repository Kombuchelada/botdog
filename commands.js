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

const LEADERBOARD_TOTAL_COMMAND = {
  name: "leaderboard-total",
  description: "Total Glizzies Guzzled leaderboard",
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const LEADERBOARD_STREAK_COMMAND = {
  name: "leaderboard-streak",
  description: "Most Consecutive Days Gagging a Gagger leaderboard",
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const LEADERBOARD_DAY_COMMAND = {
  name: "leaderboard-day",
  description: "Most Hoffies Huffed In A Single Day leaderboard",
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const LEADERBOARD_ACTIVE_COMMAND = {
  name: "leaderboard-active",
  description: "Active Streak Swallowing Sausages leaderboard",
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const LEADERBOARD_SITTING_COMMAND = {
  name: "leaderboard-sitting",
  description: "Single Sesh Sausage Supremacy leaderboard",
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const ALL_COMMANDS = [
  HOTDOG_COMMAND,
  PROTEST_COMMAND,
  LEADERBOARD_COMMAND,
  STATS_COMMAND,
  LEADERBOARD_TOTAL_COMMAND,
  LEADERBOARD_STREAK_COMMAND,
  LEADERBOARD_DAY_COMMAND,
  LEADERBOARD_ACTIVE_COMMAND,
  LEADERBOARD_SITTING_COMMAND,
];

InstallGlobalCommands(process.env.APP_ID, ALL_COMMANDS);
