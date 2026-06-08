import {
  ButtonStyleTypes,
  InteractionResponseFlags,
  InteractionResponseType,
  InteractionType,
  MessageComponentTypes,
  verifyKeyMiddleware,
} from "discord-interactions";
import {
  DiscordRequest,
  uploadInteractionAttachment,
  editOriginalInteractionMessage,
} from "./utils.js";
import {
  renderHeatmap,
  renderTimeline,
  renderLeaderboard,
  renderStatCard,
  renderWhenHeatmap,
} from "./charts.js";
import { getLeaderboardRows, getPlayerSummary, fmtRate } from "./game.js";
import { getUserProfileStmt } from "./database.js";
import {
  getLeaderboard,
  getStats,
  getTotalLeaderboard,
  getLongestStreakLeaderboard,
  getMostInADayLeaderboard,
  getMostInASittingLeaderboard,
  getCurrentStreakLeaderboard,
} from "./stats.js";
import {
  insertHotdogEventStmt,
  getUserTotalStmt,
  getTotalHotdogsStmt,
} from "./database.js";
import { detectAchievements, formatAchievementsForResponse } from "./achievements.js";

// To keep track of active protests waiting for a second (still in memory)
const activeProtests = {};

/**
 * Interactions endpoint URL where Discord will send HTTP requests
 * Parse request body and verifies incoming requests using discord-interactions package
 */
export function registerInteractions(app) {
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
            case "leaderboard-total":
              return handleTotalLeaderboardCommand(res);
            case "leaderboard-streak":
              return handleLongestStreakLeaderboardCommand(res);
            case "leaderboard-day":
              return handleMostInADayLeaderboardCommand(res);
            case "leaderboard-active":
              return handleCurrentStreakLeaderboardCommand(res);
            case "leaderboard-sitting":
              return handleMostInASittingLeaderboardCommand(res);
            case "stats":
              return handleStatsCommand(res);
            case "chart":
              return handleChartCommand(res, req);
            case "glizzy":
              return handleGlizzyCommand(res, req);
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
    },
  );
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
 * Handle ping interaction
 */
function handlePing(res) {
  return res.send({ type: InteractionResponseType.PONG });
}

/**
 * Handle leaderboard command
 * Returns all users and their hot dog counts in descending order
 */
function handleLeaderboardCommand(res) {
  let leaderboardText = getLeaderboard();

  const total = getTotalHotdogsStmt.get().total_hotdogs || 0;
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

function handleTotalLeaderboardCommand(res) {
  return res.send({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: InteractionResponseFlags.IS_COMPONENTS_V2,
      components: [
        {
          type: MessageComponentTypes.TEXT_DISPLAY,
          content: `🌭 **Total Glizzies Guzzled** 🌭\n\n${getTotalLeaderboard()}`,
        },
      ],
    },
  });
}

function handleLongestStreakLeaderboardCommand(res) {
  return res.send({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: InteractionResponseFlags.IS_COMPONENTS_V2,
      components: [
        {
          type: MessageComponentTypes.TEXT_DISPLAY,
          content: `🌭 **Most Consecutive Days Gagging a Gagger** 🌭\n\n${getLongestStreakLeaderboard()}`,
        },
      ],
    },
  });
}

function handleMostInADayLeaderboardCommand(res) {
  return res.send({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: InteractionResponseFlags.IS_COMPONENTS_V2,
      components: [
        {
          type: MessageComponentTypes.TEXT_DISPLAY,
          content: `🌭 **Most Hoffies Huffed In A Single Day** 🌭\n\n${getMostInADayLeaderboard()}`,
        },
      ],
    },
  });
}

function handleMostInASittingLeaderboardCommand(res) {
  return res.send({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: InteractionResponseFlags.IS_COMPONENTS_V2,
      components: [
        {
          type: MessageComponentTypes.TEXT_DISPLAY,
          content: `🌭 **Single Sesh Sausage Supremacy** 🌭\n\n${getMostInASittingLeaderboard()}`,
        },
      ],
    },
  });
}

function handleCurrentStreakLeaderboardCommand(res) {
  return res.send({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: InteractionResponseFlags.IS_COMPONENTS_V2,
      components: [
        {
          type: MessageComponentTypes.TEXT_DISPLAY,
          content: `🌭 **Active Streak Swallowing Sausages** 🌭\n\n${getCurrentStreakLeaderboard()}`,
        },
      ],
    },
  });
}

/**
 * Handle stats command
 * Returns server-wide stats summary
 */
function handleStatsCommand(res) {
  const stats = getStats();

  const streakUserIds = Array.isArray(stats.longestDailyStreak?.userIds)
    ? stats.longestDailyStreak.userIds
    : [];
  const streakUsers =
    streakUserIds.length > 0
      ? streakUserIds.map((userId) => `<@${userId}>`).join(", ")
      : "None";
  const streakDays = stats.longestDailyStreak?.days || 0;

  const largestUser = stats.largestSingleSessionSubmission?.userId
    ? `<@${stats.largestSingleSessionSubmission.userId}>`
    : "None";
  const largestAmount = stats.largestSingleSessionSubmission?.amount || 0;

  const averageAmount = stats.averageAmountPerDbRow || 0;

  return res.send({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: InteractionResponseFlags.IS_COMPONENTS_V2,
      components: [
        {
          type: MessageComponentTypes.TEXT_DISPLAY,
          content:
            `Total Glizzies Guzzled: ${stats.totalDogsConsumed}\n` +
            `Dogs Per Day (dpd): ${stats.dogsPerDay}\n` +
            `Dogs Per Month (dpm): ${stats.dogsPerMonth}\n` +
            `Longest Active Streak: ${streakUsers}: ${streakDays} days\n` +
            `Most Dogs In A Single Meal: ${largestUser} with ${largestAmount} dogs\n` +
            `Average Dogs Per Meal Server Wide: ${averageAmount} dogs`,
        },
      ],
    },
  });
}

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
  const serverTotal = getTotalHotdogsStmt.get().total_hotdogs || 0;

  let achievementText = "";
  try {
    const triggers = detectAchievements({
      userId,
      username,
      amount,
      userTotalAfter: newCount,
      serverTotalAfter: serverTotal,
    });
    achievementText = formatAchievementsForResponse(triggers);
  } catch (err) {
    console.error("achievement detection failed:", err);
  }

  return res.send({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: InteractionResponseFlags.IS_COMPONENTS_V2,
      components: [
        {
          type: MessageComponentTypes.TEXT_DISPLAY,
          content: `You now have ${newCount} hot dogs, ${username}! 🌭${achievementText}`,
        },
      ],
    },
  });
}

/**
 * Dispatch /chart <subcommand> [...options].
 *
 * Slash-command subcommands arrive as: req.body.data.options = [{ name, type:1, options:[...] }]
 * We defer immediately so we have up to 15 minutes to render and upload.
 */
function handleChartCommand(res, req) {
  const sub = (req.body.data.options || [])[0];
  if (!sub) {
    return res.send({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "Unknown chart subcommand." },
    });
  }

  const subOptions = sub.options || [];
  const getOpt = (name) => subOptions.find((o) => o.name === name);
  const interactionToken = req.body.token;

  // Defer the response immediately (must reply within 3 s).
  res.send({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });

  // Render + upload happen in the background. Don't await — the HTTP response is already out.
  renderAndUpload(sub.name, getOpt, req.body).catch(async (err) => {
    console.error(`/chart ${sub.name} failed:`, err);
    try {
      await editOriginalInteractionMessage(
        interactionToken,
        `Could not generate the chart — ${err.message || "unknown error"}.`,
      );
    } catch (followupErr) {
      console.error("failed to surface error to user:", followupErr);
    }
  });
}

async function renderAndUpload(subName, getOpt, body) {
  const token = body.token;
  let pngBuffer;
  let filename;
  let caption;

  switch (subName) {
    case "heatmap": {
      const userId = getOpt("user")?.value || null;
      pngBuffer = renderHeatmap({ userId });
      filename = `heatmap-${userId || "server"}.png`;
      caption = userId ? `🌭 Hot dog heatmap for <@${userId}>` : "🌭 Server hot dog heatmap";
      break;
    }
    case "timeline": {
      const userId = getOpt("user")?.value || null;
      pngBuffer = renderTimeline({ userId });
      filename = `timeline-${userId || "server"}.png`;
      caption = userId ? `🌭 Cumulative hot dogs for <@${userId}>` : "🌭 Server cumulative hot dogs";
      break;
    }
    case "leaderboard": {
      const limit = getOpt("limit")?.value ?? 10;
      pngBuffer = await renderLeaderboard({ limit });
      filename = "leaderboard.png";
      caption = "🌭 Hot dog leaderboard";
      break;
    }
    case "card": {
      let userId = getOpt("user")?.value;
      if (!userId) {
        const context = body.context;
        const invoker = context === 0 ? body.member.user : body.user;
        userId = invoker.id;
      }
      pngBuffer = await renderStatCard({ userId });
      filename = `card-${userId}.png`;
      caption = `🌭 Stat card for <@${userId}>`;
      break;
    }
    case "when": {
      const userId = getOpt("user")?.value || null;
      pngBuffer = renderWhenHeatmap({ userId });
      filename = `when-${userId || "server"}.png`;
      caption = userId ? `🌭 When <@${userId}> eats dogs` : "🌭 When the server eats dogs";
      break;
    }
    default:
      throw new Error(`unknown subcommand: ${subName}`);
  }

  await uploadInteractionAttachment(token, pngBuffer, filename, { content: caption });
}

/**
 * Dispatch /glizzy <subcommand>. All three subcommands return immediately with
 * a CHANNEL_MESSAGE_WITH_SOURCE (no deferral) — they're all fast DB queries.
 */
function handleGlizzyCommand(res, req) {
  const sub = (req.body.data.options || [])[0];
  if (!sub) return res.send({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: "Unknown glizzy subcommand." } });

  const context = req.body.context;
  const invoker = context === 0 ? req.body.member.user : req.body.user;
  const baseUrl = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");

  switch (sub.name) {
    case "leaderboard": {
      const rows = getLeaderboardRows(10);
      if (rows.length === 0) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "🌭 Nobody's playing GlizzyClicker yet. Be the first: " + (baseUrl ? `${baseUrl}/game` : "/game") },
        });
      }
      const lines = rows.map((r, i) => {
        const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `**${i + 1}.**`;
        return `${medal} <@${r.user_id}> — **${r.lifetime.toLocaleString()}** lifetime · ${r.total_buildings} buildings · ${fmtRate(r.per_second)}`;
      });
      const embed = {
        title: "🌭 GlizzyClicker Leaderboard",
        description: lines.join("\n"),
        url: baseUrl ? `${baseUrl}/game/leaderboard` : undefined,
        color: 0xff6b35,
        footer: { text: "Year of the Glizzy" },
        timestamp: new Date().toISOString(),
      };
      return res.send({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { embeds: [embed] } });
    }
    case "me": {
      const summary = getPlayerSummary(invoker.id);
      if (!summary.exists) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.EPHEMERAL,
            content: `🌭 You haven't played yet! ${baseUrl ? `${baseUrl}/game` : "/game"} — log in with Discord and start clicking.`,
          },
        });
      }
      const profile = getUserProfileStmt.get(invoker.id);
      const name = (profile && (profile.global_name || profile.username)) || invoker.username || `User ${invoker.id.slice(-4)}`;
      const fields = [
        { name: "Lifetime", value: `**${summary.state.lifetime.toLocaleString()}** 🌭`, inline: true },
        { name: "Current", value: `**${Math.floor(summary.state.glizzies).toLocaleString()}**`, inline: true },
        { name: "Per second", value: `**${summary.rates.perSecond.toFixed(1)}**`, inline: true },
        { name: "Buildings", value: String(summary.totalBuildings), inline: true },
        { name: "Clicks", value: summary.state.total_clicks.toLocaleString(), inline: true },
        { name: "Click power", value: Math.floor(summary.rates.perClick).toLocaleString(), inline: true },
      ];
      if (summary.topBuilding) {
        fields.push({
          name: "Top producer",
          value: `${summary.topBuilding.emoji} ${summary.topBuilding.name} — ${summary.topProduction.toFixed(1)}/s`,
          inline: false,
        });
      }
      if (summary.bonuses.length > 0) {
        fields.push({
          name: "Active bonuses",
          value: summary.bonuses.map((b) => `${b.emoji} **${b.name}** — ${b.explanation}`).join("\n"),
          inline: false,
        });
      }
      const embed = {
        title: `🌭 ${name}'s GlizzyClicker`,
        url: baseUrl ? `${baseUrl}/game` : undefined,
        color: 0xff6b35,
        fields,
        footer: { text: "Year of the Glizzy" },
        timestamp: new Date().toISOString(),
      };
      return res.send({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { embeds: [embed] } });
    }
    case "play": {
      const url = baseUrl ? `${baseUrl}/game` : "/game";
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          flags: InteractionResponseFlags.EPHEMERAL,
          content: `🌭 Click here to play: ${url}`,
        },
      });
    }
    default:
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: `Unknown subcommand: ${sub.name}` },
      });
  }
}
