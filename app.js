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
 * Handle test command
 */
function handleTestCommand(res) {
  return res.send({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: InteractionResponseFlags.IS_COMPONENTS_V2,
      components: [
        {
          type: MessageComponentTypes.TEXT_DISPLAY,
          content: `Have a hot dog! ${getRandomEmoji()}`,
        },
      ],
    },
  });
}
/**
 * this function handles the hotdog command.
 * It expects a positive or negative integer, and appends the
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
  console.log(req.body);
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
 * Handle challenge command
 */
function handleChallengeCommand(res, req, id) {
  const context = req.body.context;
  const userId = context === 0 ? req.body.member.user.id : req.body.user.id;
  const objectName = req.body.data.options[0].value;

  activeGames[id] = {
    id: userId,
    objectName,
  };

  return res.send({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: InteractionResponseFlags.IS_COMPONENTS_V2,
      components: [
        {
          type: MessageComponentTypes.TEXT_DISPLAY,
          content: `Rock papers scissors challenge from <@${userId}>`,
        },
        {
          type: MessageComponentTypes.ACTION_ROW,
          components: [
            {
              type: MessageComponentTypes.BUTTON,
              custom_id: `accept_button_${req.body.id}`,
              label: "Accept",
              style: ButtonStyleTypes.PRIMARY,
            },
          ],
        },
      ],
    },
  });
}

/**
 * Handle accept button
 */
async function handleAcceptButton(res, req, gameId) {
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
            content: "What is your object of choice?",
          },
          {
            type: MessageComponentTypes.ACTION_ROW,
            components: [
              {
                type: MessageComponentTypes.STRING_SELECT,
                custom_id: `select_choice_${gameId}`,
                options: getShuffledOptions(),
              },
            ],
          },
        ],
      },
    });
    await DiscordRequest(endpoint, { method: "DELETE" });
  } catch (err) {
    console.error("Error sending message:", err);
  }
}

/**
 * Handle select choice
 */
async function handleSelectChoice(res, req, gameId) {
  const { data } = req.body;

  if (!activeGames[gameId]) {
    return;
  }

  const context = req.body.context;
  const userId = context === 0 ? req.body.member.user.id : req.body.user.id;
  const objectName = data.values[0];
  const resultStr = getResult(activeGames[gameId], {
    id: userId,
    objectName,
  });

  delete activeGames[gameId];
  const endpoint = `webhooks/${process.env.APP_ID}/${req.body.token}/messages/${req.body.message.id}`;

  try {
    await res.send({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        flags: InteractionResponseFlags.IS_COMPONENTS_V2,
        components: [
          {
            type: MessageComponentTypes.TEXT_DISPLAY,
            content: resultStr,
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
            content: "Nice choice " + getRandomEmoji(),
          },
        ],
      },
    });
  } catch (err) {
    console.error("Error sending message:", err);
  }
}

/**
 * Handle message component interactions
 */
async function handleMessageComponent(res, req, data) {
  const componentId = data.custom_id;

  if (componentId.startsWith("accept_button_")) {
    const gameId = componentId.replace("accept_button_", "");
    return await handleAcceptButton(res, req, gameId);
  } else if (componentId.startsWith("select_choice_")) {
    const gameId = componentId.replace("select_choice_", "");
    return await handleSelectChoice(res, req, gameId);
  }
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
          case "test":
            return handleTestCommand(res);
          case "challenge":
            return handleChallengeCommand(res, req, id);
          case "hotdog":
            return handleHotDogCommand(res, req, id);
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
