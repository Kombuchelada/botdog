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

// Create an express app
const app = express();
// Get port, or default to 3000
const PORT = process.env.PORT || 3000;
// To keep track of our active games
const activeGames = {};

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
  if (!activeGames[userId]) {
    activeGames[userId] = {
      count: 0,
      username: username,
    };
  }
  activeGames[userId].count += amount;
  return res.send({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: InteractionResponseFlags.IS_COMPONENTS_V2,
      components: [
        {
          type: MessageComponentTypes.TEXT_DISPLAY,
          content: `You now have ${activeGames[userId].count} hot dogs, ${activeGames[userId].username}! 🌭`,
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
          default:
            console.error(`unknown command: ${name}`);
            return res.status(400).json({ error: "unknown command" });
        }

      default:
        console.error("unknown interaction type", type);
        return res.status(400).json({ error: "unknown interaction type" });
    }
  }
);

app.listen(PORT, () => {
  console.log("Listening on port", PORT);
});
