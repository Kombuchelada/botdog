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

const CHART_COMMAND = {
  name: "chart",
  description: "Generate hot dog data visualizations",
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
  options: [
    {
      name: "heatmap",
      description: "GitHub-style calendar of daily activity",
      type: 1,
      options: [
        {
          type: 6, // USER
          name: "user",
          description: "Limit to one user (default: server-wide)",
          required: false,
        },
      ],
    },
    {
      name: "timeline",
      description: "Cumulative hot dogs over time",
      type: 1,
      options: [
        {
          type: 6,
          name: "user",
          description: "Limit to one user (default: server-wide)",
          required: false,
        },
      ],
    },
    {
      name: "leaderboard",
      description: "Top users as a horizontal bar chart",
      type: 1,
      options: [
        {
          type: 4, // INTEGER
          name: "limit",
          description: "How many users to show (default 10, max 25)",
          required: false,
        },
      ],
    },
    {
      name: "card",
      description: "Single-user stat card",
      type: 1,
      options: [
        {
          type: 6,
          name: "user",
          description: "Target user (default: yourself)",
          required: false,
        },
      ],
    },
    {
      name: "when",
      description: "Day-of-week × hour-of-day submission heatmap",
      type: 1,
      options: [
        {
          type: 6,
          name: "user",
          description: "Limit to one user (default: server-wide)",
          required: false,
        },
      ],
    },
  ],
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
  CHART_COMMAND,
];

InstallGlobalCommands(process.env.APP_ID, ALL_COMMANDS);
