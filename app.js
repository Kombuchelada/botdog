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
// Initialize SQLite database for persistent hotdog counts
const db = new Database("data.db");
db.prepare(
  `CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    username TEXT,
    count INTEGER DEFAULT 0
  )`
).run();

// Prepared statements
const getUserStmt = db.prepare(
  "SELECT user_id, username, count FROM users WHERE user_id = ?"
);
const upsertUserStmt = db.prepare(
  `INSERT INTO users (user_id, username, count) VALUES (?, ?, ?)
   ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, count = excluded.count`
);
const updateCountStmt = db.prepare(
  "UPDATE users SET count = ? WHERE user_id = ?"
);

// To keep track of active protests waiting for a second (still in memory)
const activeProtests = {};

/**
 * this function handles the hotdog command.
 * It expects a positive integer, and appends the
 * amount to a map of hotdog counts per user. the key should be the users
 * id and the value should be an object with the count and username.
 * this value should be persisted in memory.
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
  // Read current count from DB
  const row = getUserStmt.get(userId);
  const newCount = (row ? row.count : 0) + amount;
  // Upsert with new count and username (use global name when set)
  upsertUserStmt.run(userId, username, newCount);

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
 * Handle a second on a protest: deduct amount from target if valid
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

  // Read target user's current count from DB
  const targetRow = getUserStmt.get(targetId);
  const oldCount = targetRow ? targetRow.count : 0;
  const newCount = Math.max(0, oldCount - amount);

  // Upsert the user's new count (use mention as username if no known username)
  const targetUsername = targetRow ? targetRow.username : `<@${targetId}>`;
  upsertUserStmt.run(targetId, targetUsername, newCount);

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

app.listen(PORT, () => {
  console.log("Listening on port", PORT);
});
