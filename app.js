import "dotenv/config";
import express from "express";
import {
  ButtonStyleTypes,
  InteractionResponseFlags,
  InteractionResponseType,
  InteractionType,
  MessageComponentTypes,
  verifyKeyMiddleware,
} from "discord-interactions";
import { getRandomEmoji, DiscordRequest } from "./utils.js";
import { getShuffledOptions, getResult } from "./game.js";
import Database from "better-sqlite3";

// Create an express app
const app = express();
// Get port, or default to 3000
const PORT = process.env.PORT || 3000;
// Initialize SQLite database for persistent hotdog tracking
const db = new Database("/database/data.db");

// Clean up old schema on startup
// Drop old users table if it exists (migration from old hotdog tracking)
// db.prepare("DROP TABLE IF EXISTS users").run();
// db.prepare("DROP VIEW IF EXISTS hotdog_totals").run();

// Create table to track each hotdog addition event
db.prepare(
  `CREATE TABLE IF NOT EXISTS hotdog_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    amount INTEGER NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`
).run();

// Create view to get current hotdog count per user
db.prepare(
  `CREATE VIEW IF NOT EXISTS hotdog_totals AS
   SELECT user_id, username, SUM(amount) as total_count
   FROM hotdog_events
   GROUP BY user_id`
).run();

// Optional one-time reset controlled by env flag (useful before a deploy)
// const shouldResetDb = process.env.RESET_DB_ON_BOOT === "true";
// if (shouldResetDb) {
//   db.prepare("DELETE FROM hotdog_events").run();
//   console.log("RESET_DB_ON_BOOT=true: cleared hotdog_events table");
// }

// Prepared statements
const insertHotdogEventStmt = db.prepare(
  "INSERT INTO hotdog_events (user_id, username, amount) VALUES (?, ?, ?)"
);
const getUserTotalStmt = db.prepare(
  "SELECT user_id, username, total_count FROM hotdog_totals WHERE user_id = ?"
);
const getLeaderboardStmt = db.prepare(
  "SELECT user_id, username, total_count FROM hotdog_totals ORDER BY total_count DESC"
);
const getTotalHotdogsStmt = db.prepare(
  "SELECT SUM(total_count) as total_hotdogs FROM hotdog_totals"
);
const getAllEventsStmt = db.prepare(
  "SELECT * FROM hotdog_events ORDER BY timestamp DESC"
);

// To keep track of active protests waiting for a second (still in memory)
const activeProtests = {};

/**
 * this function handles the hotdog command.
 * It expects a positive integer, and creates a new hotdog_event record
 * with the user's id, username, amount, and timestamp. Returns the user's
 * total count from the hotdog_totals view.
 */
function handleHotDogCommand(res, req, id) {
  const context = req.body.context;
  let user;
  if (context === 0) {
    user = req.body.member.user;
  } else {
    user = req.body.user;
  }
  const userId = user.id;
  let username = user.username;
  //use the global name if it exists
  const globalName = user.global_name;
  if (globalName) {
    username = globalName;
  }
  const amount = parseInt(req.body.data.options[0].value, 10);
  //send error if amount is less than 1
  if (amount < 1) {
    return res.send({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        flags: InteractionResponseFlags.IS_COMPONENTS_V2,
        components: [
          {
            type: MessageComponentTypes.TEXT_DISPLAY,
            content: `Please enter a positive integer amount of hot dogs, ${username}. 🌭`,
          },
        ],
      },
    });
  }
  if (amount > 83) {
    return res.send({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        flags: InteractionResponseFlags.IS_COMPONENTS_V2,
        components: [
          {
            type: MessageComponentTypes.TEXT_DISPLAY,
            content: `${amount} hot dogs? I don't believe you 🚬`,
          },
        ],
      },
    });
  }
  // Insert new event into hotdog_events table
  insertHotdogEventStmt.run(userId, username, amount);

  // Get current total from the view
  const row = getUserTotalStmt.get(userId);
  const newCount = row ? row.total_count : 0;

  return res.send({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: InteractionResponseFlags.IS_COMPONENTS_V2,
      components: [
        {
          type: MessageComponentTypes.TEXT_DISPLAY,
          content: `You now have ${newCount} hot dogs, ${username}! 🌭`,
        },
      ],
    },
  });
}

/**
 * Handle leaderboard command
 * Returns all users and their hot dog counts in descending order
 */
function handleLeaderboardCommand(res) {
  const rows = getLeaderboardStmt.all();
  const total = getTotalHotdogsStmt.get().total_hotdogs || 0;

  let leaderboardText = "";
  if (rows.length === 0) {
    leaderboardText = "No hot dog counts yet!";
  } else {
    leaderboardText = rows
      .map(
        (row, index) =>
          `${index + 1}. <@${row.user_id}> - ${row.total_count} hot dogs`
      )
      .join("\n");
  }

  return res.send({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: InteractionResponseFlags.IS_COMPONENTS_V2,
      components: [
        {
          type: MessageComponentTypes.TEXT_DISPLAY,
          content: `🌭 **Hot Dog Leaderboard** 🌭\n\n${leaderboardText}\n\nTotal glizzies guzzled: ${total}`,
        },
      ],
    },
  });
}

/**
 * Handle ping interaction
 */
function handlePing(res) {
  return res.send({ type: InteractionResponseType.PONG });
}

/**
 * Handle protest command
 * Options: user (target), amount (integer)
 */
function handleProtestCommand(res, req, id) {
  const context = req.body.context;
  let protestor;
  if (context === 0) {
    protestor = req.body.member.user;
  } else {
    protestor = req.body.user;
  }
  const protestorId = protestor.id;

  const targetId = req.body.data.options[0].value;
  const amount = parseInt(req.body.data.options[1].value, 10);

  // Protest amount must be positive
  if (amount < 1) {
    return res.send({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        flags: InteractionResponseFlags.IS_COMPONENTS_V2,
        components: [
          {
            type: MessageComponentTypes.TEXT_DISPLAY,
            content: `Please enter a positive integer amount of hot dogs to protest. 🌭`,
          },
        ],
      },
    });
  }

  // Check if protest would make target's count go negative
  const targetRow = getUserTotalStmt.get(targetId);
  const currentCount = targetRow ? targetRow.total_count : 0;
  if (currentCount - amount < 0) {
    return res.send({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        flags: InteractionResponseFlags.IS_COMPONENTS_V2,
        components: [
          {
            type: MessageComponentTypes.TEXT_DISPLAY,
            content: `Cannot protest ${amount} hot dogs from <@${targetId}> (current total: ${currentCount}). This would result in a negative count.`,
          },
        ],
      },
    });
  }

  // store protest state keyed by interaction id
  activeProtests[id] = {
    targetId,
    amount,
    protestorId,
  };

  return res.send({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: InteractionResponseFlags.IS_COMPONENTS_V2,
      components: [
        {
          type: MessageComponentTypes.TEXT_DISPLAY,
          content: `<@${protestorId}> protests <@${targetId}> for ${amount} hot dogs. Second to confirm.`,
        },
        {
          type: MessageComponentTypes.ACTION_ROW,
          components: [
            {
              type: MessageComponentTypes.BUTTON,
              custom_id: `second_protest_${id}`,
              label: "Second",
              style: ButtonStyleTypes.DANGER,
            },
          ],
        },
      ],
    },
  });
}

/**
 * Handle message component interactions
 */
async function handleMessageComponent(res, req, data) {
  const componentId = data.custom_id;

  if (componentId.startsWith("second_protest_")) {
    const protestId = componentId.replace("second_protest_", "");
    return await handleSecondProtest(res, req, protestId);
  }
}

/**
 * Handle a second on a protest: insert negative amount event to reduce target's count
 */
async function handleSecondProtest(res, req, protestId) {
  const protest = activeProtests[protestId];
  if (!protest) return;

  const context = req.body.context;
  let seconder;
  if (context === 0) {
    seconder = req.body.member.user;
  } else {
    seconder = req.body.user;
  }
  const seconderId = seconder.id;

  // cannot second your own protest
  if (seconderId === protest.protestorId) {
    return res.send({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        flags:
          InteractionResponseFlags.EPHEMERAL |
          InteractionResponseFlags.IS_COMPONENTS_V2,
        components: [
          {
            type: MessageComponentTypes.TEXT_DISPLAY,
            content: `You cannot second your own protest.`,
          },
        ],
      },
    });
  }

  const { targetId, amount } = protest;

  // Insert a negative amount event to record the protest
  // This creates an audit trail while reducing the target's total
  insertHotdogEventStmt.run(targetId, `<@${targetId}>`, -amount);

  // Get the target's updated total from the view
  const targetRow = getUserTotalStmt.get(targetId);
  const newCount = targetRow ? targetRow.total_count : 0;

  // respond to the seconder and update the original message
  const endpoint = `webhooks/${process.env.APP_ID}/${req.body.token}/messages/${req.body.message.id}`;

  try {
    await res.send({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        flags:
          InteractionResponseFlags.EPHEMERAL |
          InteractionResponseFlags.IS_COMPONENTS_V2,
        components: [
          {
            type: MessageComponentTypes.TEXT_DISPLAY,
            content: `You seconded the protest — deducted ${amount} from <@${targetId}>.`,
          },
        ],
      },
    });

    await DiscordRequest(endpoint, {
      method: "PATCH",
      body: {
        components: [
          {
            type: MessageComponentTypes.TEXT_DISPLAY,
            content: `Protest resolved: <@${seconderId}> seconded; <@${targetId}> now has ${newCount} hot dogs.`,
          },
        ],
      },
    });
  } catch (err) {
    console.error("Error resolving protest:", err);
  }

  delete activeProtests[protestId];
}

/**
 * Interactions endpoint URL where Discord will send HTTP requests
 * Parse request body and verifies incoming requests using discord-interactions package
 */
app.post(
  "/interactions",
  verifyKeyMiddleware(process.env.PUBLIC_KEY),
  async function (req, res) {
    // Interaction id, type and data
    const { id, type, data } = req.body;

    switch (type) {
      case InteractionType.PING:
        return handlePing(res);

      case InteractionType.APPLICATION_COMMAND:
        const { name } = data;
        switch (name) {
          case "hotdog":
            return handleHotDogCommand(res, req, id);
          case "protest":
            return handleProtestCommand(res, req, id);
          case "leaderboard":
            return handleLeaderboardCommand(res);
          default:
            console.error(`unknown command: ${name}`);
            return res.status(400).json({ error: "unknown command" });
        }

      case InteractionType.MESSAGE_COMPONENT:
        return await handleMessageComponent(res, req, data);

      default:
        console.error("unknown interaction type", type);
        return res.status(400).json({ error: "unknown interaction type" });
    }
  }
);

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

app.listen(PORT, () => {
  console.log("Listening on port", PORT);
});
